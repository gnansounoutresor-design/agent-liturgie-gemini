import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import readline from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import { GoogleGenAI } from '@google/genai';
import { Document, Packer, Paragraph, HeadingLevel } from 'docx';

// ======================================================
// 1. CONFIGURATION
// ======================================================

const ROOT = process.cwd();
const CORPUS_DIR = path.join(ROOT, 'corpus');
const HISTORY_DIR = path.join(ROOT, 'historique');

const GENERATIONS_FILE = path.join(HISTORY_DIR, 'generations.jsonl');
const VALIDATED_FILE = path.join(HISTORY_DIR, 'valides.jsonl');

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const MAX_CORRECTIONS = 1;
const SIMILARITY_THRESHOLD = 0.48;

function requireEnv(name) {
  const value = process.env[name];

  if (!value || value === 'COLLE_TA_CLE_ICI') {
    throw new Error(
      `La variable ${name} n'est pas configurée. ` +
      'Vérifie ton fichier .env sans partager ta clé API.'
    );
  }

  return value;
}

async function ensureHistoryFiles() {
  await fs.mkdir(HISTORY_DIR, { recursive: true });

  for (const file of [GENERATIONS_FILE, VALIDATED_FILE]) {
    try {
      await fs.access(file);
    } catch {
      await fs.writeFile(file, '', 'utf8');
    }
  }
}

// ======================================================
// 2. QUESTIONS
// ======================================================

async function ask(rl, label, optional = false) {
  const suffix = optional ? ' (facultatif)' : '';

  while (true) {
    const answer = (
      await rl.question(`${label}${suffix} : `)
    ).trim();

    if (answer || optional) return answer;

    console.log(
      'Ce champ est nécessaire. Tu peux écrire « à vérifier » si nécessaire.'
    );
  }
}

// ======================================================
// 3. CORPUS ET EXEMPLES DE STYLE
// ======================================================

function tokenize(s) {
  return (s || '')
    .toLocaleLowerCase('fr')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .split(/[^a-z0-9]+/)
    .filter(w => w.length > 3);
}

function selectExamples(examples, query, limit = 3) {
  const terms = new Set(tokenize(query));
  const scored = examples.map((e, index) => {
    const title = new Set(tokenize(e.title || ''));
    const filename = new Set(tokenize(e.filename || ''));
    const intros = new Set(tokenize((e.intro_1 || '') + ' ' + (e.intro_2 || '')));
    const prayers = new Set(tokenize([e.pu1,e.pu2,e.pu3,e.pu4].filter(Boolean).join(' ')));
    let score = 0;
    for (const word of terms) {
      if (word.length < 3) continue;
      if (title.has(word)) score += 4;
      if (filename.has(word)) score += 1.5;
      if (intros.has(word)) score += 2;
      if (prayers.has(word)) score += 0.5;
    }
    const fields = [e.intro_1,e.intro_2,e.pu1,e.pu2,e.pu3,e.pu4];
    score += fields.filter(v => typeof v === 'string' && v.trim().length > 20).length * 0.25;
    return { e, score, index };
  });
  scored.sort((a, b) => b.score - a.score || a.index - b.index);
  return scored.slice(0, limit).map(item => item.e);
}
function formatExample(e, i) {
  return `
EXEMPLE DE STYLE ${i + 1}
ATTENTION : EXTRACTION AUTOMATIQUE NON VALIDÉE.
UTILISER UNIQUEMENT POUR LE TON ET LA FORMULATION.

Titre : ${e.title || e.filename || 'Sans titre'}

Introduction 1 :
${e.intro_1 || '[Non extraite]'}

Introduction 2 :
${e.intro_2 || '[Non extraite]'}

Prière universelle 1 :
${e.pu1 || '[Non extraite]'}

Prière universelle 2 :
${e.pu2 || '[Non extraite]'}

Prière universelle 3 :
${e.pu3 || '[Non extraite]'}

Prière universelle 4 :
${e.pu4 || '[Non extraite]'}
`.trim();
}

async function readCorpus() {
  const file = path.join(CORPUS_DIR, 'exemples_uniques_a_revoir.jsonl');

  try {
    const raw = await fs.readFile(file, 'utf8');

    return raw
      .split(/\r?\n/)
      .filter(Boolean)
      .map(line => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch (error) {
    if (error.code === 'ENOENT') {
      console.warn('Corpus absent : génération sans exemples de référence.');
      return [];
    }

    throw error;
  }
}

// ======================================================
// 4. NETTOYAGE DU TEXTE
// ======================================================

function cleanDocxText(text) {
  return String(text || '')
    .replace(/^```(?:markdown|md|text)?\s*/i, '')
    .replace(/```\s*$/i, '')
    .trim();
}

function normalizeText(text) {
  return cleanDocxText(text)
    .replace(/\r\n/g, '\n')
    .replace(/[ \t]+/g, ' ')
    .trim();
}

// ======================================================
// 5. COMPARAISON DES FORMULATIONS
// ======================================================

function normalizeForComparison(text) {
  return String(text || '')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function getWords(text) {
  const ignored = new Set([
    'dans', 'avec', 'pour', 'par', 'sur', 'sous',
    'une', 'des', 'les', 'aux', 'leur', 'leurs',
    'nous', 'vous', 'notre', 'votre', 'qui', 'que',
    'quoi', 'dont', 'est', 'sont', 'etre', 'avoir',
    'afin', 'ainsi', 'mais', 'donc', 'car', 'comme',
    'plus', 'moins', 'tres', 'tout', 'tous', 'toute',
    'toutes', 'seigneur', 'prions', 'intention'
  ]);

  return new Set(
    normalizeForComparison(text)
      .split(' ')
      .filter(word => word.length > 2 && !ignored.has(word))
  );
}

function similarityScore(textA, textB) {
  const wordsA = getWords(textA);
  const wordsB = getWords(textB);

  if (!wordsA.size || !wordsB.size) return 0;

  let common = 0;

  for (const word of wordsA) {
    if (wordsB.has(word)) common++;
  }

  const union = new Set([...wordsA, ...wordsB]).size;

  return union ? common / union : 0;
}

async function readHistory() {
  await ensureHistoryFiles();

  const content = await fs.readFile(GENERATIONS_FILE, 'utf8');

  return content
    .split(/\r?\n/)
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

async function saveGeneration(entry) {
  await ensureHistoryFiles();

  await fs.appendFile(
    GENERATIONS_FILE,
    JSON.stringify({
      dateGeneration: new Date().toISOString(),
      ...entry
    }) + '\n',
    'utf8'
  );
}

async function askForValidation(rl, entry) {
  const answer = (
    await rl.question(
      '\nSouhaites-tu conserver ce travail dans les textes validés ? (o/n) : '
    )
  ).trim().toLowerCase();

  if (!['o', 'oui'].includes(answer)) return;

  await ensureHistoryFiles();

  await fs.appendFile(
    VALIDATED_FILE,
    JSON.stringify({
      dateValidation: new Date().toISOString(),
      ...entry
    }) + '\n',
    'utf8'
  );

  console.log('Travail enregistré dans historique\\valides.jsonl.');
}

function compareWithHistory(currentText, history, limit = 5) {
  return history
    .map(entry => ({
      title: entry.title || 'Travail précédent',
      date: entry.dateGeneration || 'Date inconnue',
      score: similarityScore(
        currentText,
        entry.text || entry.generated || ''
      )
    }))
    .filter(entry => entry.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}

// ======================================================
// 6. CONTRÔLE DE QUALITÉ
// ======================================================

function extractSection(text, headingPattern) {
  const lines = normalizeText(text).split('\n');

  const start = lines.findIndex(line =>
    headingPattern.test(line.trim())
  );

  if (start === -1) return null;

  const result = [];

  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i].trim();

    if (/^#{1,3}\s+/.test(line)) break;

    result.push(line);
  }

  return result.join('\n').trim();
}

function extractNumberedItems(text) {
  const lines = text.split('\n');
  const items = [];
  let current = null;

  for (const raw of lines) {
    const line = raw.trim();

    const match = line.match(/^(?:[-*]\s*)?([1-4])\s*[.)]\s+(.+)$/);

    if (match) {
      if (current) items.push(current.trim());
      current = match[2].trim();
      continue;
    }

    if (current && line && !/^#{1,3}\s+/.test(line)) {
      current += ' ' + line;
    }
  }

  if (current) items.push(current.trim());

  return items;
}

function countSentences(text) {
  const cleaned = text.replace(
    /\b(?:M\.|Mme|Mlle|St\.|Ste\.)/gi,
    match => match.replace('.', '<POINT>')
  );

  return cleaned
    .split(/[.!?]+(?:\s|$)/)
    .map(s => s.trim())
    .filter(Boolean).length;
}

function checkQuality(text, references) {
  const content = normalizeText(text);
  const errors = [];
  const warnings = [];
  const passed = [];

  const introSection = extractSection(
    content,
    /^(?:#{1,3}\s*)?(?:1\.\s*)?Introductions?\s+aux\s+lectures\s*$/i
  );

  const prayerSection = extractSection(
    content,
    /^(?:#{1,3}\s*)?(?:2\.\s*)?Pri[eè]re\s+universelle\s*$/i
  );

  if (!introSection) {
    errors.push('La section « Introductions aux lectures » est absente ou mal formatée.');
  }

  if (!prayerSection) {
    errors.push('La section « Prière universelle » est absente ou mal formatée.');
  }

  if (introSection) {
    const introLines = introSection
      .split('\n')
      .map(s => s.trim())
      .filter(Boolean);

    const intro1 = introLines.find(line =>
      /^[-*•]?\s*(?:Premi[eè]re|1re|1ère)\s+lecture\s*:/i.test(line)
    );

    const intro2 = introLines.find(line =>
      /^[-*•]?\s*(?:Deuxi[eè]me|2e|2ème)\s+lecture\s*:/i.test(line)
    );

    if (!intro1 || !intro2) {
      errors.push('Les deux introductions ne sont pas clairement identifiées.');
    } else {
      passed.push('Les deux introductions sont présentes.');

      for (const [label, line] of [
        ['Première lecture', intro1],
        ['Deuxième lecture', intro2]
      ]) {
        const body = line.replace(/^[-*•]?\s*[^:]+:\s*/, '').trim();

        if (countSentences(body) !== 1) {
          errors.push(`${label} : le texte doit contenir exactement une phrase.`);
        }

        if (/\[À VÉRIFIER\]|\[A VERIFIER\]/i.test(body)) {
          warnings.push(`${label} : une information nécessite une vérification.`);
        }
      }

      if (introLines.indexOf(intro1) > introLines.indexOf(intro2)) {
        errors.push('L’ordre des introductions est incorrect.');
      }
    }
  }

  if (prayerSection) {
    const items = extractNumberedItems(prayerSection);

    if (items.length !== 4) {
      errors.push(`Quatre intentions étaient attendues, mais ${items.length} ont été détectées.`);
    } else {
      passed.push('Les quatre intentions sont présentes.');

      items.forEach((item, index) => {
        const number = index + 1;

        if (!/Seigneur,\s*nous te prions\.?\s*$/i.test(item)) {
          errors.push(`Intention ${number} : formule finale manquante ou incorrecte.`);
        }

        if (!/\b(?:Dieu|Seigneur|Père|Jésus|Christ)\b/i.test(item)) {
          warnings.push(`Intention ${number} : l'adresse à Dieu mérite d'être vérifiée.`);
        }

        const words = item.split(/\s+/).filter(Boolean).length;

        if (words < 18) {
          warnings.push(`Intention ${number} : texte très court (${words} mots).`);
        }

        if (words > 85) {
          warnings.push(`Intention ${number} : texte très long (${words} mots).`);
        }
      });
    }
  }

  const forbiddenPatterns = [
    /^#{1,3}\s*.*\bOuverture\b/im,
    /^#{1,3}\s*.*\bIntroduction\s+à\s+l['’]Évangile\b/im,
    /^#{1,3}\s*.*\bLiturgie\s+eucharistique\b/im,
    /^#{1,3}\s*.*\bConclusion\b/im
  ];

  if (forbiddenPatterns.some(pattern => pattern.test(content))) {
    errors.push('Une section interdite est présente dans le résultat.');
  }

  if (!errors.length) passed.push('Aucune erreur structurelle détectée.');

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    passed
  };
}

// ======================================================
// 7. RAPPORT DE QUALITÉ
// ======================================================

function printQualityReport(report, attempts, comparisons = []) {
  console.log('\n==========================================');
  console.log('       RAPPORT DE CONTRÔLE QUALITÉ');
  console.log('==========================================');
  console.log(`Modèle : ${MODEL}`);
  console.log(`Tentatives : ${attempts}`);

  if (report.passed.length) {
    console.log('\nCONTRÔLES RÉUSSIS :');
    for (const item of report.passed) console.log(`  [OK] ${item}`);
  }

  if (report.errors.length) {
    console.log('\nERREURS :');
    for (const item of report.errors) console.log(`  [ERREUR] ${item}`);
  }

  if (report.warnings.length) {
    console.log('\nAVERTISSEMENTS :');
    for (const item of report.warnings) console.log(`  [!] ${item}`);
  }

  if (comparisons.length) {
    console.log('\nSIMILARITÉS AVEC L’HISTORIQUE :');

    for (const item of comparisons) {
      console.log(
        `  ${Math.round(item.score * 100)} % — ${item.title} (${item.date})`
      );
    }
  } else {
    console.log('\nAucune similarité lexicale significative détectée.');
  }

  console.log(
    '\nCe rapport ne certifie pas l’exactitude biblique, ' +
    'la justesse théologique ou la conformité liturgique.'
  );
  console.log('==========================================\n');
}

// ======================================================
// 8. EXPORT WORD
// ======================================================

async function saveDocx(title, content, report, attempts, comparisons = []) {
  const lines = cleanDocxText(content).split(/\r?\n/);
  const children = [];

  for (const raw of lines) {
    const line = raw.trim();

    if (!line) {
      children.push(new Paragraph({ text: '' }));
      continue;
    }

    if (/^#{1,2}\s+/.test(line)) {
      children.push(new Paragraph({
        text: line.replace(/^#{1,2}\s+/, ''),
        heading: /^#\s/.test(line)
          ? HeadingLevel.HEADING_1
          : HeadingLevel.HEADING_2
      }));
      continue;
    }

    if (/^[-*]\s+/.test(line)) {
      children.push(new Paragraph({
        text: line.replace(/^[-*]\s+/, ''),
        bullet: { level: 0 }
      }));
      continue;
    }

    children.push(new Paragraph({ text: line }));
  }

  children.push(
    new Paragraph({ text: '' }),
    new Paragraph({
      text: 'RAPPORT DE CONTRÔLE QUALITÉ',
      heading: HeadingLevel.HEADING_1
    }),
    new Paragraph({ text: `Modèle utilisé : ${MODEL}` }),
    new Paragraph({ text: `Tentatives : ${attempts}` }),
    new Paragraph({
      text: report.valid
        ? 'Structure : conforme aux contrôles automatiques.'
        : 'Structure : erreurs restantes.'
    })
  );

  for (const item of report.passed) {
    children.push(new Paragraph({ text: `OK — ${item}` }));
  }

  for (const item of report.errors) {
    children.push(new Paragraph({ text: `ERREUR — ${item}` }));
  }

  for (const item of report.warnings) {
    children.push(new Paragraph({ text: `AVERTISSEMENT — ${item}` }));
  }

  if (comparisons.length) {
    children.push(new Paragraph({
      text: 'SIMILARITÉS AVEC LES GÉNÉRATIONS PRÉCÉDENTES',
      heading: HeadingLevel.HEADING_2
    }));

    for (const item of comparisons) {
      children.push(new Paragraph({
        text: `${Math.round(item.score * 100)} % — ${item.title} (${item.date})`
      }));
    }
  }

  children.push(new Paragraph({
    text:
      'Le contrôle automatique ne garantit pas l’exactitude des références ' +
      'bibliques ni la conformité théologique. Une relecture humaine est indispensable.'
  }));

  const doc = new Document({
    sections: [{ properties: {}, children }]
  });

  const buffer = await Packer.toBuffer(doc);

  const safeTitle = (title || 'travail_liturgique')
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 70) || 'travail_liturgique';

  const filePath = path.join(
    ROOT,
    `introductions_et_pu_${safeTitle}.docx`
  );

  await fs.writeFile(filePath, buffer);

  return filePath;
}

// ======================================================
// 9. GESTION DES ERREURS GEMINI
// ======================================================

function isTemporaryError(err) {
  const status = Number(err?.status ?? err?.code ?? err?.error?.code);
  const message = String(err?.message || err);

  return (
    [429, 500, 502, 503, 504].includes(status) ||
    /UNAVAILABLE|high demand|temporar|RESOURCE_EXHAUSTED|overloaded|ECONNRESET|ETIMEDOUT|fetch failed/i.test(message)
  );
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function generateWithRetry(ai, request, maxAttempts = 3) {
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ai.models.generateContent(request);
    } catch (err) {
      if (!isTemporaryError(err)) throw err;

      if (attempt === maxAttempts) {
        throw new Error(
          `Gemini reste indisponible après ${maxAttempts} tentatives. ` +
          `Détail : ${err?.message || err}`
        );
      }

      const delayMs = attempt * 4000;

      console.log(
        `Gemini est temporairement indisponible. Nouvelle tentative ` +
        `${attempt + 1}/${maxAttempts} dans ${delayMs / 1000} secondes...`
      );

      await sleep(delayMs);
    }
  }

  throw new Error('Échec inattendu de la génération Gemini.');
}

// ======================================================
// 10. PROGRAMME PRINCIPAL
// ======================================================

async function main() {
  const apiKey = requireEnv('GEMINI_API_KEY');
  const ai = new GoogleGenAI({ apiKey });

  const rl = readline.createInterface({ input, output });

  try {
    await ensureHistoryFiles();

    console.log('\n=== ASSISTANT LITURGIQUE ===\n');
    console.log(
      'Génération exclusive : deux introductions aux lectures et ' +
      'quatre intentions de prière universelle.'
    );
    console.log(`Modèle configuré : ${MODEL}`);
    console.log('Les références bibliques ne sont pas vérifiées automatiquement.\n');

    const date = await ask(rl, 'Date de la célébration (ex. 2026-11-01)');
    const celebration = await ask(rl, 'Nom de la célébration / dimanche');
    const temps = await ask(rl, 'Temps liturgique et année (A, B ou C)');
    const lecture1 = await ask(rl, 'Première lecture : livre, chapitre et versets');
    const lecture2 = await ask(rl, 'Deuxième lecture : livre, chapitre et versets');
    const evangile = await ask(rl, 'Évangile : livre, chapitre et versets');
    const textes = await ask(rl, 'Textes bibliques ou extraits', true);
    const modele = await ask(rl, 'Consignes locales / particularités', true);

    const title = `${celebration} ${temps} ${date}`;

    const style = await fs.readFile(
      path.join(CORPUS_DIR, 'guide_style_liturgique.md'),
      'utf8'
    );

    const examples = await readCorpus();

    const relevant = selectExamples(
      examples,
      `${celebration} ${temps} ${lecture1} ${lecture2} ${evangile}`,
      3
    );

    const examplesText = relevant
      .map((e, i) => formatExample(e, i))
      .join('\n\n---\n\n');

    const history = await readHistory();

    // N'envoyer à Gemini que quelques travaux antérieurs pour aider
    // à varier les formulations. Le corpus de référence reste séparé.
    const previousTexts = history
      .slice(-8)
      .map((entry, i) =>
        `GÉNÉRATION ANTÉRIEURE ${i + 1} :\n${entry.text || ''}`
      )
      .join('\n\n---\n\n');

    const systemInstruction = `
Tu es un assistant de rédaction liturgique catholique francophone.

MISSION EXCLUSIVE :
Produire exactement deux introductions aux lectures et quatre intentions de prière universelle.

N'ajoute aucune ouverture, aucun chant, aucune introduction à l'Évangile,
aucune liturgie eucharistique et aucune conclusion.

GUIDE DE STYLE LOCAL :
${style}

FIABILITÉ :
- Les exemples locaux peuvent provenir d'extractions automatiques non validées.
- Utilise-les uniquement comme références de style, jamais comme autorité biblique.
- N'invente pas de références bibliques.
- Conserve les références fournies par l'utilisateur.
- Si une donnée est incertaine, signale-le sans inventer.
- N'affirme pas avoir consulté une source que tu n'as pas consultée.
- Écris en français naturel, sobre, pastoral et facile à proclamer oralement.

DIVERSITÉ :
- Évite de reprendre mot pour mot des formulations de travaux précédents.
- Varie les constructions syntaxiques, les verbes et les amorces.
- Garde un ton liturgique catholique cohérent.
- Ne varie jamais au détriment de la fidélité aux lectures et de la clarté.
- Les formules liturgiques obligatoires doivent rester exactes.
`.trim();

    const basePrompt = `
Rédige uniquement deux introductions aux lectures et quatre intentions de prière universelle.

CÉLÉBRATION
Date : ${date}
Nom : ${celebration}
Temps liturgique et année : ${temps}

PREMIÈRE LECTURE : ${lecture1}
DEUXIÈME LECTURE : ${lecture2}
ÉVANGILE : ${evangile}

TEXTES BIBLIQUES FOURNIS :
${textes || '[Aucun texte intégral fourni]'}

CONSIGNES LOCALES :
${modele || '[Aucune]'}

EXEMPLES LOCAUX — STYLE SEULEMENT :
${examplesText || '[Aucun exemple disponible]'}

TRAVAUX ANTÉRIEURS À NE PAS COPIER :
${previousTexts || '[Aucune génération antérieure]'}

FORMAT OBLIGATOIRE :

# ${title}

## 1. Introductions aux lectures

- Première lecture : exactement une phrase présentant le message central de la lecture.
- Deuxième lecture : exactement une phrase présentant le message central de la lecture.

Commence naturellement, par exemple :
« Dans cet extrait du livre de… »
« À travers sa lettre aux… »

Ne recopie pas systématiquement ces amorces : utilise-les comme possibilités, pas comme formule obligatoire.
Conserve les références bibliques fournies et ne les invente pas.

## 2. Prière universelle

Rédige exactement quatre intentions dans cet ordre :

1. L'Église : le Pape, les évêques, les prêtres et la mission de l'Église.
2. Les dirigeants : justice, paix et bien commun.
3. Les personnes souffrantes : malades, pauvres, opprimés et personnes éprouvées.
4. L'assemblée : une demande liée précisément au message des lectures.

Chaque intention doit adresser explicitement une demande à Dieu, être concrète,
naturelle à l'oral et comporter environ deux à quatre lignes.

Chaque intention doit se terminer exactement par :
« Seigneur, nous te prions. »

N'ajoute aucune autre section.
`.trim();

    async function generate(prompt, temperature = 0.65) {
      const response = await generateWithRetry(ai, {
        model: MODEL,
        contents: prompt,
        config: {
          systemInstruction,
          temperature,
          maxOutputTokens: 3500
        }
      });

      const text = response.text?.trim();

      if (!text) throw new Error('Gemini n’a renvoyé aucun texte.');

      return cleanDocxText(text);
    }

    console.log('\nGénération initiale en cours...\n');

    let generated = await generate(basePrompt);
    let attempts = 1;
    let report = checkQuality(generated, { lecture1, lecture2 });

    // Correction structurelle si nécessaire.
    if (!report.valid && attempts <= MAX_CORRECTIONS) {
      console.log('\nCorrection structurelle en cours...\n');

      const correctionPrompt = `
Corrige le texte ci-dessous sans changer les références bibliques.

ERREURS :
${report.errors.map(e => '- ' + e).join('\n')}

TEXTE :
${generated}

Respecte toutes les consignes initiales.
Retourne uniquement le texte corrigé, sans commentaire.
`.trim();

      attempts++;

      try {
        const corrected = await generate(correctionPrompt, 0.25);
        const correctedReport = checkQuality(corrected, { lecture1, lecture2 });

        if (correctedReport.errors.length <= report.errors.length) {
          generated = corrected;
          report = correctedReport;
        }
      } catch (error) {
        console.error('Correction automatique impossible :', error.message);
      }
    }

    // Comparaison individuelle avec l'historique.
    let comparisons = compareWithHistory(generated, history);

    const highestSimilarity = comparisons[0]?.score || 0;

    // Si le texte ressemble beaucoup à des générations précédentes,
    // demander une nouvelle version et garder la meilleure version valide.
    if (highestSimilarity >= SIMILARITY_THRESHOLD) {
      console.log(
        `\nSimilarité lexicale élevée détectée (${Math.round(highestSimilarity * 100)} %).`
      );
      console.log('Tentative de reformulation pour améliorer la diversité...\n');

      const reformulationPrompt = `
Reformule le travail suivant pour produire des formulations réellement différentes.

MOTIF :
Le texte ressemble trop à des travaux précédents.

TEXTE À REFORMULER :
${generated}

TRAVAUX PRÉCÉDENTS :
${previousTexts || '[Aucun]'}

CONSIGNES :
- Conserve exactement les deux introductions et les quatre intentions.
- Respecte les références bibliques fournies.
- Préserve le message spirituel et le style pastoral catholique.
- Modifie les constructions de phrases et les choix de verbes.
- Évite les reprises textuelles inutiles.
- Ne modifie pas la formule finale « Seigneur, nous te prions. »
- N'ajoute aucun commentaire.
- Retourne uniquement le texte complet reformulé.
`.trim();

      attempts++;

      try {
        const alternative = await generate(reformulationPrompt, 0.8);
        const alternativeReport = checkQuality(alternative, { lecture1, lecture2 });
        const alternativeComparisons = compareWithHistory(alternative, history);
        const alternativeScore = alternativeComparisons[0]?.score || 0;

        // N'accepter la nouvelle version que si elle reste structurellement
        // conforme et qu'elle n'est pas plus similaire à l'historique.
        if (
          alternativeReport.valid &&
          (!report.valid || alternativeScore < highestSimilarity)
        ) {
          generated = alternative;
          report = alternativeReport;
          comparisons = alternativeComparisons;

          console.log('La reformulation a été retenue.');
        } else {
          console.log(
            'La première version est conservée : la reformulation ' +
            'n’améliore pas suffisamment les contrôles.'
          );
        }
      } catch (error) {
        console.error('Reformulation impossible :', error.message);
      }
    }

    // Vérification finale et enregistrement.
    report = checkQuality(generated, { lecture1, lecture2 });
    comparisons = compareWithHistory(generated, history);

    console.log('\n========== TEXTE GÉNÉRÉ ==========\n');
    console.log(generated);

    printQualityReport(report, attempts, comparisons);

    const filePath = await saveDocx(
      title,
      generated,
      report,
      attempts,
      comparisons
    );

    console.log(`Document Word créé : ${filePath}`);

    // L'historique est séparé du corpus de référence.
    await saveGeneration({
      title,
      date,
      celebration,
      temps,
      lecture1,
      lecture2,
      evangile,
      text: generated,
      valid: report.valid,
      similarity: comparisons[0]?.score || 0
    });

    console.log('Génération enregistrée dans historique\\generations.jsonl.');

    if (!report.valid) {
      console.log(
        '\nAttention : des erreurs structurelles restent présentes. ' +
        'Relis et corrige le document avant utilisation.'
      );
    }

    await askForValidation(rl, {
      title,
      date,
      celebration,
      temps,
      text: generated,
      valid: report.valid
    });

    console.log(
      '\nVérifie toujours les références bibliques, le contenu théologique ' +
      'et les usages liturgiques avant la célébration.'
    );
  } finally {
    rl.close();
  }
}

// ======================================================
// 11. GESTION GÉNÉRALE DES ERREURS
// ======================================================

main().catch(err => {
  console.error('\nERREUR :', err?.message || err);
  process.exitCode = 1;
});