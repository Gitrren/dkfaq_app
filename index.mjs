import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import {
    Client,
    GatewayIntentBits,
    Routes,
    REST,
    Events,
    ChannelType,
    MessageFlags,
    ComponentType,
    ButtonStyle,
    PermissionFlagsBits,
} from 'discord.js';
import {
    loadFaq,
    getFaqContent,
    getFaqsByCategory,
    faqExists,
    getFaqHeader,
} from './faq-loader.mjs';

// ===== Configuração =====
const TOKEN = process.env.DISCORD_TOKEN;
const APPLICATION_ID = process.env.DISCORD_APPLICATION_ID;
const BANNER_URL = 'https://i.imgur.com/hjumDtb.gif';

if (!TOKEN || !APPLICATION_ID) {
    console.error('[ERROR] Variáveis de ambiente ausentes. Configure DISCORD_TOKEN e DISCORD_APPLICATION_ID no .env');
    process.exit(1);
}

const STORE = path.join(process.cwd(), 'message.json');
const FAQ_FILE = path.join(process.cwd(), 'faq.json');
const TEST_FAQ_FILE = path.join(process.cwd(), 'testfaq.json');

// Cache de idioma em memória (não persiste entre reinícios)
const userLangCache = new Map();

// ===== Persistência (Store Multi-Guild) =====
const ensureStoreShape = (raw = {}) => {
    const store = { guilds: {} };

    if (raw.guilds && typeof raw.guilds === 'object') {
        for (const [guildId, entry] of Object.entries(raw.guilds)) {
            if (!guildId) continue;
            store.guilds[guildId] = {
                channelId: entry?.channelId || null,
                messageId: entry?.messageId || null,
                nonce: entry?.nonce || 1,
            };
        }
    }

    return store;
};

const readStore = () => {
    if (!fs.existsSync(STORE)) return { guilds: {} };
    try {
        const data = JSON.parse(fs.readFileSync(STORE, 'utf8'));
        return ensureStoreShape(data);
    } catch {
        return { guilds: {} };
    }
};

const writeStore = (d) => {
    const normalized = ensureStoreShape(d);
    fs.writeFileSync(STORE, JSON.stringify(normalized, null, 2));
    return normalized;
};

// ===== Logger =====
function logMessage(tag, message) {
    const msg = `[${tag}] ${message || ''}`.trim();
    if (tag === 'ERROR' || tag === 'WARN') {
        console.error(msg);
    } else {
        console.log(msg);
    }
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Estado de suporte à mídia (detectado uma vez por execução)
let inlineMediaSupported = null;
// Carrega FAQ na inicialização
loadFaq();

// ===== Suporte a Mídia Inline (Components V2) =====
function detectInlineMediaType() {
    const candidates = ['Media', 'ImageDisplay', 'MediaGallery', 'FileDisplay', 'Image', 'MediaDisplay', 'ImageComponent'];
    for (const name of candidates) {
        if (ComponentType[name] !== undefined) {
            return { type: ComponentType[name], name };
        }
    }
    return null;
}

function getMediaSupport() {
    if (inlineMediaSupported === null) {
        inlineMediaSupported = detectInlineMediaType() !== null;
    }
    return inlineMediaSupported;
}

function buildInlineMediaComponent(url, fileType = 'image') {
    const mediaType = detectInlineMediaType();
    if (!mediaType) return null;

    try {
        const lowerUrl = url.toLowerCase();
        const isVideo = fileType === 'video' || lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.webp');

        if (isVideo && lowerUrl.includes('imgur')) {
            let videoUrl = url;
            if (url.includes('imgur.com/') && !url.includes('i.imgur.com/')) {
                videoUrl = url.replace('imgur.com/', 'i.imgur.com/');
            }
            return { type: mediaType.type, items: [{ media: { url: videoUrl } }] };
        }

        if (mediaType.name === 'MediaGallery') {
            return { type: mediaType.type, items: [{ media: { url } }] };
        }

        if (mediaType.name === 'ImageDisplay' || mediaType.name === 'Media') {
            return { type: mediaType.type, url };
        }

        if (mediaType.name === 'FileDisplay') {
            return { type: mediaType.type, file: { url } };
        }

        return { type: mediaType.type, url };
    } catch (e) {
        logMessage('ERROR', `mídia inline: ${e.message}`);
        return null;
    }
}

// Mapa para imagens reutilizáveis
const IMAGES = {};

// ===== Parser de Conteúdo =====
function parseContentMarkers(text) {
    const fileRegex = /\[file:(https?:\/\/[^\]]+|[^\]]+)\]/g;
    const linkRegex = /\[link:(https?:\/\/[^\]|]+)\|([^\]]+)\]/g;
    const parts = [];
    const markers = [];

    let match;
    while ((match = fileRegex.exec(text)) !== null) {
        markers.push({ type: 'file', index: match.index, length: match[0].length, fileRef: match[1] });
    }
    fileRegex.lastIndex = 0;

    while ((match = linkRegex.exec(text)) !== null) {
        markers.push({ type: 'link', index: match.index, length: match[0].length, url: match[1], label: match[2] });
    }

    markers.sort((a, b) => a.index - b.index);
    let lastIndex = 0;

    for (const marker of markers) {
        if (marker.index > lastIndex) {
            const textContent = text.slice(lastIndex, marker.index).trim();
            if (textContent) parts.push({ type: 'text', content: textContent });
        }

        if (marker.type === 'file') {
            const fileRef = marker.fileRef;
            let fileUrl = null;

            if (fileRef.startsWith('http://') || fileRef.startsWith('https://')) {
                fileUrl = fileRef;
            } else if (fileRef.includes('.') && (fileRef.includes('/') || fileRef.includes('.'))) {
                fileUrl = `https://${fileRef}`;
            } else if (IMAGES[fileRef]) {
                fileUrl = IMAGES[fileRef];
            }

            if (fileUrl) {
                const lowerUrl = fileUrl.toLowerCase();
                let ft = 'image';
                if (lowerUrl.endsWith('.webm') || lowerUrl.endsWith('.mp4') || lowerUrl.endsWith('.webp')) {
                    ft = 'video';
                }
                parts.push({ type: 'file', url: fileUrl, fileType: ft });
            }
        } else if (marker.type === 'link') {
            parts.push({ type: 'link', url: marker.url, label: marker.label });
        }

        lastIndex = marker.index + marker.length;
    }

    if (lastIndex < text.length) {
        const textContent = text.slice(lastIndex).trim();
        if (textContent) parts.push({ type: 'text', content: textContent });
    }

    return parts;
}

// ===== Carregador de FAQ por arquivo =====
function loadFaqFromFile(filePath) {
    if (!fs.existsSync(filePath)) return null;
    try {
        return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch {
        return null;
    }
}

function getFaqsByFile(filePath, categoryId) {
    const data = loadFaqFromFile(filePath);
    if (!data?.faqs) return [];
    const result = [];
    for (const [key, faq] of Object.entries(data.faqs)) {
        // Check if has content in any language
        const hasContent = faq?.content && Object.values(faq.content).some(v => v && (typeof v === 'string' ? v.trim() : true));
        const hasLabel = faq?.label;
        if ((faq.categoryId || faq.category) === categoryId && hasContent && hasLabel) {
            result.push({
                key,
                label: faq.label.substring(0, 100),
            });
        }
    }
    return result;
}

function getFaqContentFromFile(filePath, key, lang = 'en') {
    const data = loadFaqFromFile(filePath);
    const faq = data?.faqs?.[key];
    if (!faq) return null;
    return faq.content?.[lang] || faq.content?.en || null;
}

function faqExistsInFile(filePath, key) {
    const data = loadFaqFromFile(filePath);
    return key in (data?.faqs || {});
}

// ===== Construtores de Componentes =====
function buildCv2Root(nonce = 1, prefix = 'select') {
    const headerText = getFaqHeader('en') || '## **FAQ - Frequently Asked Questions**\nHello and welcome! Here you can access official answers to frequently raised topics by our community.';
    const data = loadFaq();

    const components = [
        {
            type: ComponentType.TextDisplay,
            content: headerText
        },
    ];

    const categories = (data?.categories || []).map(cat => ({
        key: cat.id,
        placeholder: cat.label?.substring(0, 90) || cat.id,
        customId: `${prefix}_${cat.id}:${nonce}`,
    }));

    if (!categories.length && data?.faqs) {
        const derived = new Set(Object.values(data.faqs).map(f => f.categoryId || f.category).filter(Boolean));
        for (const id of derived) categories.push({ key: id, placeholder: id, customId: `${prefix}_${id}:${nonce}` });
    }

    for (const cat of categories) {
        const faqs = getFaqsByCategory(cat.key);
        if (!faqs || faqs.length === 0) {
            logMessage('WARN', `categoria "${cat.key}" sem FAQs válidos`);
            continue;
        }

        const options = faqs.slice(0, 25).map(f => ({ label: f.label, value: f.key }));

        components.push({
            type: ComponentType.ActionRow,
            components: [{
                type: ComponentType.StringSelect,
                custom_id: cat.customId,
                placeholder: cat.placeholder,
                options,
            }],
        });
    }

    if (getMediaSupport()) {
        const mediaComponent = buildInlineMediaComponent(BANNER_URL);
        if (mediaComponent) components.push(mediaComponent);
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [{ type: ComponentType.Container, components }],
    };
}

function buildTestRoot(nonce = 1) {
    const testData = loadFaqFromFile(TEST_FAQ_FILE);
    if (!testData?.faqs) return null;

    const headerText = testData.rootMessage?.en || testData.header?.en || '## **[TEST] FAQ**\nThis is a TEST version.';
    
    const components = [
        {
            type: ComponentType.TextDisplay,
            content: `[TEST] ${headerText}`
        },
    ];

    const categories = (testData.categories || []).map(cat => ({
        key: cat.id,
        placeholder: cat.label || cat.id,
        customId: `tselect_${cat.id}:${nonce}`,
    }));

    if (!categories.length) {
        const derived = new Set(Object.values(testData.faqs).map(f => f.categoryId || f.category).filter(Boolean));
        for (const id of derived) categories.push({ key: id, placeholder: id, customId: `tselect_${id}:${nonce}` });
    }

    for (const cat of categories) {
        const faqs = getFaqsByFile(TEST_FAQ_FILE, cat.key);
        if (!faqs || faqs.length === 0) continue;

        const options = faqs.slice(0, 25).map(f => ({ label: f.label, value: f.key }));

        components.push({
            type: ComponentType.ActionRow,
            components: [{
                type: ComponentType.StringSelect,
                custom_id: cat.customId,
                placeholder: cat.placeholder,
                options,
            }],
        });
    }

    if (getMediaSupport()) {
        const mediaComponent = buildInlineMediaComponent(BANNER_URL);
        if (mediaComponent) components.push(mediaComponent);
    }

    return {
        flags: MessageFlags.IsComponentsV2,
        components: [{ type: ComponentType.Container, components }],
    };
}

function buildLanguageToggle(contentKey, currentLang, isTest = false) {
    const isEn = currentLang === 'en';
    const prefix = isTest ? 'tlang_btn' : 'lang_btn';
    return {
        type: ComponentType.ActionRow,
        components: [
            {
                type: ComponentType.Button,
                custom_id: `${prefix}:${contentKey}:${isEn ? 'pt' : 'en'}`,
                style: ButtonStyle.Secondary,
                label: isEn ? 'Portuguese' : 'English',
                emoji: isEn ? '🇧🇷' : '🇺🇸',
            },
        ],
    };
}

function buildCv2Reply(contentKey, lang, isTest = false) {
    const filePath = isTest ? TEST_FAQ_FILE : FAQ_FILE;
    const text = isTest
        ? (getFaqContentFromFile(filePath, contentKey, lang) || 'Conteúdo não encontrado.')
        : (getFaqContent(contentKey, lang) || 'Conteúdo não encontrado.');

    const components = [];
    const parts = parseContentMarkers(text);

    for (const part of parts) {
        if (part.type === 'text') {
            components.push({ type: ComponentType.TextDisplay, content: part.content });
        } else if (part.type === 'file') {
            const mediaComponent = buildInlineMediaComponent(part.url, part.fileType);
            if (mediaComponent) components.push(mediaComponent);
        } else if (part.type === 'link') {
            components.push({
                type: ComponentType.ActionRow,
                components: [{
                    type: ComponentType.Button,
                    style: ButtonStyle.Link,
                    url: part.url,
                    label: part.label
                }]
            });
        }
    }

    components.push(buildLanguageToggle(contentKey, lang, isTest));

    return {
        flags: MessageFlags.IsComponentsV2 | MessageFlags.Ephemeral,
        components: [{ type: ComponentType.Container, components }],
    };
}

// ===== Registro de Comandos =====
async function registerCommands() {
    const rest = new REST({ version: '10' }).setToken(TOKEN);
    const body = [
        {
            name: 'faq',
            description: 'Gerencia o sistema de FAQ do servidor.',
            default_member_permissions: PermissionFlagsBits.Administrator.toString(),
            options: [
                {
                    name: 'setup',
                    description: 'Cria ou atualiza a mensagem de FAQ neste canal.',
                    type: 1,
                    options: [
                        { name: 'channel', description: 'Canal onde postar a mensagem', type: 7, required: false },
                    ],
                },
                {
                    name: 'test',
                    description: 'Cria ou atualiza uma mensagem de FAQ de TESTE (testfaq.json).',
                    type: 1,
                    options: [
                        { name: 'channel', description: 'Canal onde postar a mensagem de teste', type: 7, required: false },
                    ],
                },
                {
                    name: 'import',
                    description: 'Importa um arquivo JSON para faq.json ou testfaq.json.',
                    type: 1,
                    options: [
                        { name: 'arquivo', description: 'Arquivo JSON para importar', type: 11, required: true },
                        {
                            name: 'destino',
                            description: 'Onde salvar o arquivo',
                            type: 3, // STRING
                            required: false,
                            choices: [
                                { name: 'faq.json (produção)', value: 'faq' },
                                { name: 'testfaq.json (teste)', value: 'test' },
                            ],
                        },
                    ],
                },
                {
                    name: 'export',
                    description: 'Exporta o faq.json atual como arquivo.',
                    type: 1,
                    options: [
                        {
                            name: 'arquivo',
                            description: 'Qual arquivo exportar',
                            type: 3,
                            required: false,
                            choices: [
                                { name: 'faq.json (produção)', value: 'faq' },
                                { name: 'testfaq.json (teste)', value: 'test' },
                            ],
                        },
                    ],
                },
            ],
        },
    ];

    try {
        await rest.put(Routes.applicationCommands(APPLICATION_ID), { body });
    } catch (err) {
        logMessage('ERROR', `registrar comandos: ${err.message}`);
    }
}

// ===== Eventos =====
client.once(Events.ClientReady, async () => {
    logMessage('BOOT', `logado como ${client.user.tag}`);

    await registerCommands();

    const store = readStore();
    let storeChanged = false;

    for (const [guildId, entry] of Object.entries(store.guilds)) {
        try {
            const guild = await client.guilds.fetch(guildId);
            const channel = entry.channelId ? await guild.channels.fetch(entry.channelId).catch(() => null) : null;

            if (!channel || channel.type !== ChannelType.GuildText) {
                logMessage('WARN', `canal do FAQ ausente para guild ${guildId}`);
                continue;
            }

            let message = null;
            if (entry.messageId) {
                message = await channel.messages.fetch(entry.messageId).catch(() => null);
            }

            if (!message) {
                const nextNonce = (entry.nonce || 1) + 1;
                const newMsg = await channel.send(buildCv2Root(nextNonce));
                entry.messageId = newMsg.id;
                entry.channelId = channel.id;
                entry.nonce = nextNonce;
                storeChanged = true;
                logMessage('SETUP', `FAQ criado em <#${channel.id}>`);
            }
        } catch (e) {
            logMessage('WARN', `falha ao restaurar FAQ da guild ${guildId}: ${e.message}`);
        }
    }

    if (storeChanged) writeStore(store);

    logMessage('BOOT', 'pronto');
});

// Interações
client.on(Events.InteractionCreate, async (i) => {
    try {
        // /faq command
        if (i.isChatInputCommand() && i.commandName === 'faq') {
            const subcommand = i.options.getSubcommand();
            const guildId = i.guildId;

            if (!guildId) {
                await i.reply({ content: 'Este comando só pode ser usado em servidores.', flags: MessageFlags.Ephemeral });
                return;
            }

            // /faq setup [channel]
            if (subcommand === 'setup') {
                const targetChannel = i.options.getChannel('channel') || i.channel;

                if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
                    await i.reply({ content: 'Escolha um canal de texto válido.', flags: MessageFlags.Ephemeral });
                    return;
                }

                const store = readStore();
                const guildEntry = store.guilds[guildId] || { nonce: 1 };
                store.guilds[guildId] = guildEntry;

                let msg = null;
                try {
                    const msgs = await targetChannel.messages.fetch({ limit: 10 });
                    msg = msgs.find(m => m.author.id === client.user.id) || null;
                } catch (err) {
                    logMessage('WARN', `falha ao buscar mensagens: ${err.message}`);
                }

                const nextNonce = (guildEntry.nonce || 1) + 1;
                const payload = buildCv2Root(nextNonce);

                if (msg) {
                    await msg.edit(payload);
                    guildEntry.messageId = msg.id;
                    guildEntry.channelId = targetChannel.id;
                    guildEntry.nonce = nextNonce;
                    writeStore(store);
                    await i.reply({ content: `✅ FAQ atualizado em <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
                    logMessage('SETUP', `FAQ atualizado em <#${targetChannel.id}>`);
                } else {
                    const newMsg = await targetChannel.send(payload);
                    guildEntry.messageId = newMsg.id;
                    guildEntry.channelId = targetChannel.id;
                    guildEntry.nonce = nextNonce;
                    writeStore(store);
                    await i.reply({ content: `✅ FAQ criado em <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
                    logMessage('SETUP', `FAQ criado em <#${targetChannel.id}>`);
                }
                return;
            }

            // /faq test [channel]
            if (subcommand === 'test') {
                const targetChannel = i.options.getChannel('channel') || i.channel;

                if (!targetChannel || targetChannel.type !== ChannelType.GuildText) {
                    await i.reply({ content: 'Escolha um canal de texto válido.', flags: MessageFlags.Ephemeral });
                    return;
                }

                if (!fs.existsSync(TEST_FAQ_FILE)) {
                    await i.reply({ content: '❌ Arquivo testfaq.json não encontrado.', flags: MessageFlags.Ephemeral });
                    logMessage('WARN', 'testfaq.json não encontrado');
                    return;
                }

                const payload = buildTestRoot(Date.now());
                if (!payload) {
                    await i.reply({ content: '❌ Erro ao carregar testfaq.json.', flags: MessageFlags.Ephemeral });
                    return;
                }

                let msg = null;
                try {
                    const msgs = await targetChannel.messages.fetch({ limit: 10 });
                    msg = msgs.find(m => m.author.id === client.user.id) || null;
                } catch (err) {
                    logMessage('WARN', `falha ao buscar mensagens: ${err.message}`);
                }

                if (msg) {
                    await msg.edit(payload);
                    await i.reply({ content: `✅ FAQ de teste atualizado em <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
                    logMessage('SETUP', `FAQ de teste atualizado em <#${targetChannel.id}>`);
                } else {
                    await targetChannel.send(payload);
                    await i.reply({ content: `✅ FAQ de teste criado em <#${targetChannel.id}>.`, flags: MessageFlags.Ephemeral });
                    logMessage('SETUP', `FAQ de teste criado em <#${targetChannel.id}>`);
                }
                return;
            }

            // /faq import <arquivo> [destino]
            if (subcommand === 'import') {
                const attachment = i.options.getAttachment('arquivo');
                const destino = i.options.getString('destino') || 'faq'; // default: faq.json

                if (!attachment) {
                    await i.reply({ content: '❌ Anexe um arquivo .json.', flags: MessageFlags.Ephemeral });
                    return;
                }

                if (!attachment.name.endsWith('.json')) {
                    await i.reply({ content: '❌ O arquivo deve ser um .json', flags: MessageFlags.Ephemeral });
                    return;
                }

                await i.deferReply({ flags: MessageFlags.Ephemeral });

                try {
                    const response = await fetch(attachment.url);
                    if (!response.ok) {
                        await i.editReply({ content: '❌ Falha ao baixar o arquivo.' });
                        return;
                    }

                    const text = await response.text();
                    let data;
                    try {
                        data = JSON.parse(text);
                    } catch {
                        await i.editReply({ content: '❌ JSON inválido. Verifique a sintaxe.' });
                        return;
                    }

                    if (!data.faqs || typeof data.faqs !== 'object') {
                        await i.editReply({ content: '❌ Estrutura inválida: falta "faqs".' });
                        return;
                    }

                    const faqCount = Object.keys(data.faqs).length;
                    if (faqCount === 0) {
                        await i.editReply({ content: '❌ O arquivo não contém nenhum FAQ.' });
                        return;
                    }

                    // Salvar no destino escolhido
                    const targetFile = destino === 'test' ? TEST_FAQ_FILE : FAQ_FILE;
                    const targetName = destino === 'test' ? 'testfaq.json' : 'faq.json';
                    fs.writeFileSync(targetFile, JSON.stringify(data, null, 4));

                    // Se for faq.json, recarregar na memória
                    if (destino === 'faq') {
                        const { reloadFaq } = await import('./faq-loader.mjs');
                        reloadFaq();
                    }

                    // Atualizar mensagem do FAQ em todos os guilds configurados
                    if (destino === 'faq') {
                        const currentStore = readStore();
                        let updatedCount = 0;
                        
                        for (const [storedGuildId, entry] of Object.entries(currentStore.guilds)) {
                            if (!entry.channelId || !entry.messageId) continue;
                            
                            try {
                                const guild = await client.guilds.fetch(storedGuildId);
                                const channel = await guild.channels.fetch(entry.channelId).catch(() => null);
                                if (!channel) continue;
                                
                                const message = await channel.messages.fetch(entry.messageId).catch(() => null);
                                if (!message) continue;
                                
                                const nextNonce = (entry.nonce || 1) + 1;
                                await message.edit(buildCv2Root(nextNonce));
                                entry.nonce = nextNonce;
                                updatedCount++;
                            } catch (e) {
                                logMessage('WARN', `falha ao atualizar FAQ em guild ${storedGuildId}: ${e.message}`);
                            }
                        }
                        
                        writeStore(currentStore);
                        
                        if (updatedCount > 0) {
                            await i.editReply({ content: `✅ Importado para ${targetName}! ${faqCount} FAQs. Mensagem do FAQ atualizada em ${updatedCount} servidor(es).` });
                        } else {
                            await i.editReply({ content: `✅ Importado para ${targetName}! ${faqCount} FAQs. Use /faq setup para criar a mensagem.` });
                        }
                    } else {
                        await i.editReply({ content: `✅ Importado para ${targetName}! ${faqCount} FAQs.` });
                    }
                    
                    logMessage('SETUP', `FAQ importado para ${targetName}: ${faqCount} FAQs`);
                } catch (err) {
                    await i.editReply({ content: `❌ Erro: ${err.message}` });
                    logMessage('ERROR', `importar FAQ: ${err.message}`);
                }
                return;
            }

            // /faq export [arquivo]
            if (subcommand === 'export') {
                const arquivo = i.options.getString('arquivo') || 'faq';
                const targetFile = arquivo === 'test' ? TEST_FAQ_FILE : FAQ_FILE;
                const targetName = arquivo === 'test' ? 'testfaq.json' : 'faq.json';

                if (!fs.existsSync(targetFile)) {
                    await i.reply({ content: `❌ Arquivo ${targetName} não encontrado.`, flags: MessageFlags.Ephemeral });
                    return;
                }

                try {
                    const fileContent = fs.readFileSync(targetFile, 'utf8');
                    JSON.parse(fileContent); // valida JSON

                    // Criar buffer do arquivo para attachment
                    const buffer = Buffer.from(fileContent, 'utf8');
                    
                    // Botão para o editor online
                    const editorButton = {
                        type: ComponentType.ActionRow,
                        components: [
                            {
                                type: ComponentType.Button,
                                style: ButtonStyle.Link,
                                label: 'FAQ EDITOR',
                                url: 'https://gurren.squareweb.app/',
                                emoji: { name: '✏️' }
                            }
                        ]
                    };

                    await i.reply({
                        components: [editorButton],
                        files: [{
                            attachment: buffer,
                            name: targetName
                        }],
                        flags: MessageFlags.Ephemeral
                    });

                    logMessage('EXPORT', `${targetName} exportado por ${i.user.tag}`);
                } catch (err) {
                    await i.reply({ content: `❌ Erro ao exportar: ${err.message}`, flags: MessageFlags.Ephemeral });
                    logMessage('ERROR', `exportar FAQ: ${err.message}`);
                }
                return;
            }

            return;
        }

        // Select menu handlers (faq.json) - matches any category
        if (i.isStringSelectMenu() && /^select_[a-z0-9_]+:\d+$/.test(i.customId)) {
            const contentKey = i.values[0];
            if (!faqExists(contentKey)) {
                await i.reply({ content: 'Conteúdo não encontrado.', flags: MessageFlags.Ephemeral });
                return;
            }
            const userLang = userLangCache.get(i.user.id) || 'en';
            await i.reply(buildCv2Reply(contentKey, userLang, false));
            return;
        }

        // Select menu handlers (testfaq.json) - matches any category
        if (i.isStringSelectMenu() && /^tselect_[a-z0-9_]+:\d+$/.test(i.customId)) {
            const contentKey = i.values[0];
            if (!faqExistsInFile(TEST_FAQ_FILE, contentKey)) {
                await i.reply({ content: 'Conteúdo não encontrado.', flags: MessageFlags.Ephemeral });
                return;
            }
            const userLang = userLangCache.get(i.user.id) || 'en';
            await i.reply(buildCv2Reply(contentKey, userLang, true));
            return;
        }

        // Language toggle (faq.json)
        if (i.isButton() && i.customId.startsWith('lang_btn:')) {
            const [, contentKey, newLang] = i.customId.split(':');
            const targetLang = newLang === 'pt' ? 'pt' : 'en';
            userLangCache.set(i.user.id, targetLang);
            await i.update(buildCv2Reply(contentKey, targetLang, false));
            return;
        }

        // Language toggle (testfaq.json)
        if (i.isButton() && i.customId.startsWith('tlang_btn:')) {
            const [, contentKey, newLang] = i.customId.split(':');
            const targetLang = newLang === 'pt' ? 'pt' : 'en';
            userLangCache.set(i.user.id, targetLang);
            await i.update(buildCv2Reply(contentKey, targetLang, true));
            return;
        }
    } catch (err) {
        logMessage('ERROR', `interaction: ${err.message}`);
        if (!i.replied && !i.deferred) {
            await i.reply({ content: 'Erro ao processar. Tenta de novo.', flags: MessageFlags.Ephemeral });
        }
    }
});

// ===== Inicialização =====
client.login(TOKEN);
