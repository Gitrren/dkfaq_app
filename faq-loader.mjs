import fs from 'node:fs';
import path from 'node:path';

const FAQ_FILE = path.join(process.cwd(), 'faq.json');

let faqData = null;

// Copia todas as chaves de idioma de um objeto, garantindo que o fallback existe
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
    
    if (!result[fallbackLang]) {
        result[fallbackLang] = '';
    }
    
    return result;
}

// Normaliza dados do FAQ de diferentes formatos de entrada
// Suporta categorias como array ou objeto, deriva categorias dos FAQs se necessário
function normalizeFaqData(raw) {
    const base = { rootMessage: { en: '' }, categories: [], faqs: {} };
    if (!raw || typeof raw !== 'object') return base;

    const result = { rootMessage: {}, categories: [], faqs: {} };
    
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
            const label = (typeof value === 'object' ? (value.en || Object.values(value)[0]) : value) || id;
            result.categories.push({ id, label });
            seen.add(id);
        }
    }

    // Processa FAQs e deriva categorias se não existirem
    if (raw.faqs && typeof raw.faqs === 'object') {
        for (const [key, faq] of Object.entries(raw.faqs)) {
            const safeKey = key.toString();
            const categoryId = (faq.categoryId || faq.category || 'general').toString().toLowerCase();
            if (categoryId && !seen.has(categoryId)) {
                result.categories.push({ id: categoryId, label: categoryId });
                seen.add(categoryId);
            }
            
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

export function getFaqContent(key, lang = 'en') {
    const data = loadFaq();
    if (!data?.faqs?.[key]) return null;
    const content = data.faqs[key].content;
    return content?.[lang] || content?.en || null;
}

export function getFaqsByCategory(category) {
    const data = loadFaq();
    if (!data?.faqs) return [];

    const result = [];
    for (const [key, faq] of Object.entries(data.faqs)) {
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

export function faqExists(key) {
    const data = loadFaq();
    return key in (data?.faqs || {});
}

export function reloadFaq() {
    return loadFaq(true);
}

export function getFaqHeader(lang = 'en') {
    const data = loadFaq();
    return data?.rootMessage?.[lang] || data?.rootMessage?.en || '';
}

export function getAvailableLanguages() {
    const data = loadFaq();
    if (!data?.rootMessage) return ['en'];
    return Object.keys(data.rootMessage);
}

loadFaq();
