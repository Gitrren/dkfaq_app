/**
 * Drakantos FAQ Loader
 * Carrega e fornece os dados do FAQ a partir de faq.json
 * Suporta idiomas dinâmicos com fallback para inglês
 */


import fs from 'node:fs';
import path from 'node:path';

const FAQ_FILE = path.join(process.cwd(), 'faq.json');

let faqData = null;

/**
 * Copia todas as chaves de idioma de um objeto
 * @param {object} source - Objeto fonte com chaves de idioma
 * @param {string} fallbackLang - Idioma de fallback (default: 'en')
 * @returns {object} Objeto com todas as chaves de idioma copiadas
 */
function copyLanguageKeys(source, fallbackLang = 'en') {
    if (!source || typeof source !== 'object') {
        return { [fallbackLang]: '' };
    }
    
    const result = {};
    for (const [lang, value] of Object.entries(source)) {
        if (typeof value === 'string') {
            result[lang] = value;
        }
    }
    
    // Garante que pelo menos o idioma de fallback existe
    if (!result[fallbackLang]) {
        result[fallbackLang] = '';
    }
    
    return result;
}

function normalizeFaqData(raw) {
    const base = { rootMessage: { en: '' }, categories: [], faqs: {} };
    if (!raw || typeof raw !== 'object') return base;

    const result = { rootMessage: {}, categories: [], faqs: {} };
    
    // Copia todos os idiomas do rootMessage/header
    const rootSource = raw.rootMessage || raw.header || {};
    result.rootMessage = copyLanguageKeys(rootSource);

    const seen = new Set();
    if (Array.isArray(raw.categories)) {
        for (const cat of raw.categories) {
            const id = (cat.id || cat.key || cat.label || '').toString().trim().toLowerCase() || null;
            if (!id || seen.has(id)) continue;
            result.categories.push({ id, label: cat.label || id });
            seen.add(id);
        }
    } else if (raw.categories && typeof raw.categories === 'object') {
        for (const [key, value] of Object.entries(raw.categories)) {
            const id = key.toString().trim().toLowerCase();
            if (!id || seen.has(id)) continue;
            // Tenta pegar label de qualquer idioma disponível
            const label = (typeof value === 'object' ? (value.en || Object.values(value)[0]) : value) || id;
            result.categories.push({ id, label });
            seen.add(id);
        }
    }

    if (raw.faqs && typeof raw.faqs === 'object') {
        for (const [key, faq] of Object.entries(raw.faqs)) {
            const safeKey = key.toString();
            const categoryId = (faq.categoryId || faq.category || 'general').toString().toLowerCase();
            if (categoryId && !seen.has(categoryId)) {
                result.categories.push({ id: categoryId, label: categoryId });
                seen.add(categoryId);
            }
            
            // Copia todos os idiomas do content
            const contentSource = faq.content || {};
            const content = copyLanguageKeys(contentSource);
            
            result.faqs[safeKey] = {
                categoryId,
                label: faq.label || faq.labels?.en || safeKey,
                content
            };
        }
    }

    if (!result.categories.length) {
        result.categories.push({ id: 'general', label: 'General' });
    }

    return result;
}

/**
 * Carrega o FAQ do arquivo JSON
 * @param {boolean} force - Força recarregamento
 * @returns {object|null} Dados do FAQ ou null se não encontrado
 */
export function loadFaq(force = false) {
    if (faqData && !force) return faqData;

    try {
        if (!fs.existsSync(FAQ_FILE)) {
            console.error('[ERROR] faq.json não encontrado');
            return null;
        }

        const raw = fs.readFileSync(FAQ_FILE, 'utf8');
        const parsed = JSON.parse(raw);
        faqData = normalizeFaqData(parsed);

        const faqCount = Object.keys(faqData.faqs || {}).length;
        const catCount = (faqData.categories || []).length;
        const langs = Object.keys(faqData.rootMessage || {});
        console.log(`[FAQ] carregado: ${faqCount} FAQs em ${catCount} categorias, idiomas: ${langs.join(', ')}`);

        return faqData;
    } catch (err) {
        console.error(`[ERROR] carregar faq: ${err.message}`);
        return null;
    }
}

/**
 * Obtém conteúdo de um FAQ específico
 * @param {string} key - Chave do FAQ
 * @param {string} lang - Idioma desejado (fallback para 'en')
 * @returns {string|null} Conteúdo do FAQ ou null
 */
export function getFaqContent(key, lang = 'en') {
    const data = loadFaq();
    if (!data?.faqs?.[key]) return null;
    const content = data.faqs[key].content;
    return content?.[lang] || content?.en || null;
}

/**
 * Obtém todos os FAQs de uma categoria
 * @param {string} category - ID da categoria
 * @returns {Array} Lista de FAQs { key, label }
 */
export function getFaqsByCategory(category) {
    const data = loadFaq();
    if (!data?.faqs) return [];

    const result = [];
    for (const [key, faq] of Object.entries(data.faqs)) {
        // Verifica se tem conteúdo em qualquer idioma
        const hasContent = faq?.content && Object.values(faq.content).some(v => v && v.trim());
        const hasLabel = faq?.label;

        if (faq.categoryId === category && hasContent && hasLabel) {
            result.push({
                key,
                label: faq.label.substring(0, 100),
            });
        }
    }
    return result;
}

/**
 * Verifica se um FAQ existe
 * @param {string} key - Chave do FAQ
 * @returns {boolean}
 */
export function faqExists(key) {
    const data = loadFaq();
    return key in (data?.faqs || {});
}

/**
 * Recarrega o FAQ do arquivo
 * @returns {object|null}
 */
export function reloadFaq() {
    return loadFaq(true);
}

/**
 * Obtém o header/rootMessage do FAQ
 * @param {string} lang - Idioma desejado (fallback para 'en')
 * @returns {string}
 */
export function getFaqHeader(lang = 'en') {
    const data = loadFaq();
    return data?.rootMessage?.[lang] || data?.rootMessage?.en || '';
}

/**
 * Obtém lista de idiomas disponíveis no FAQ
 * @returns {string[]}
 */
export function getAvailableLanguages() {
    const data = loadFaq();
    if (!data?.rootMessage) return ['en'];
    return Object.keys(data.rootMessage);
}

// Carregar na importação
loadFaq();
