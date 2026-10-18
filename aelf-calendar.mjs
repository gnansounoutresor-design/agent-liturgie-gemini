const AELF_BASE = 'https://www.aelf.org';

function getBeninToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Porto-Novo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(new Date());

  const values = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${values.year}-${values.month}-${values.day}`;
}

function isValidDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  const parsed = new Date(`${date}T00:00:00Z`);
  return !Number.isNaN(parsed.getTime())
    && parsed.toISOString().slice(0, 10) === date;
}

function decodeEntities(text) {
  return text
    .replace(/&nbsp;|&#160;|&#xA0;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)));
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(?:p|div|section|article|h[1-6]|li|tr)>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
  )
    .replace(/\r/g, '')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
}

function getReference(html, labelPattern) {
  const links = html.match(/<a\b[^>]*class="[^"]*\blecture_link\b[^"]*"[^>]*>[\s\S]*?<\/a>/gi) || [];

  for (const link of links) {
    const label = link.match(/<span\b[^>]*class="[^"]*\bsubhead\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    if (!label || !labelPattern.test(htmlToText(label[1]))) continue;

    const ref = link.match(/<span\b[^>]*class="[^"]*\bref\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);
    const title = link.match(/<span\b[^>]*class="[^"]*\btitle\b[^"]*"[^>]*>([\s\S]*?)<\/span>/i);

    return {
      reference: ref ? htmlToText(ref[1]) : '',
      title: title ? htmlToText(title[1]) : ''
    };
  }

  return { reference: '', title: '' };
}

function getReadingText(html, number) {
  const marker = `id="messe1_lecture${number}"`;
  const start = html.indexOf(marker);

  if (start < 0) return '';

  const nextMarker = /id="messe1_lecture\d+"/g;
  nextMarker.lastIndex = start + marker.length;
  const next = nextMarker.exec(html);

  const section = html.slice(start, next ? next.index : Math.min(html.length, start + 20000));
  return htmlToText(section);
}

function findCelebration(text) {
  const lines = text.split('\n').map(line => line.trim()).filter(Boolean);

  return lines.find(line =>
    /(?:dimanche|lundi|mardi|mercredi|jeudi|vendredi|samedi)\b.*(?:Année [ABC]|Temps ordinaire|Avent|Carême|Pâques|Noël)/i.test(line)
  ) || lines.find(line => /Année [ABC]/i.test(line)) || '';
}

export async function getAelfLiturgy(date) {
  if (!isValidDate(date)) {
    throw new Error('Date invalide. Utilise le format AAAA-MM-JJ.');
  }

  if (date < getBeninToday()) {
    throw new Error('La date choisie est passée au Bénin.');
  }

  const url = `${AELF_BASE}/${date}/romain/messe`;

  let response;
  try {
    response = await fetch(url, {
      headers: { 'User-Agent': 'AssistantLiturgique/1.0' },
      signal: AbortSignal.timeout(15000)
    });
  } catch {
    throw new Error('Impossible de joindre le calendrier AELF. Réessaie plus tard.');
  }

  if (!response.ok) {
    throw new Error(`Le calendrier AELF a répondu avec le statut ${response.status}.`);
  }

  const html = await response.text();
  const pageText = htmlToText(html);

  const premiere = getReference(html, /^Première lecture$/i);
  const psaume = getReference(html, /^Psaume$/i);
  const deuxieme = getReference(html, /^Deuxième lecture$/i);
  const evangile = getReference(html, /^Évangile$/i);

  if (!premiere.reference || !evangile.reference) {
    throw new Error('Les références bibliques n’ont pas pu être extraites de la page AELF.');
  }

  const celebration = findCelebration(pageText);
  const yearMatch = pageText.match(/Année ([ABC])/i);

  return {
    date,
    source: url,
    celebration,
    anneeLiturgique: yearMatch ? yearMatch[1].toUpperCase() : '',
    premiereLecture: premiere.reference,
    titrePremiereLecture: premiere.title,
    textePremiereLecture: getReadingText(html, 1),
    psaume: psaume.reference,
    titrePsaume: psaume.title,
    textePsaume: getReadingText(html, 2),
    deuxiemeLecture: deuxieme.reference,
    titreDeuxiemeLecture: deuxieme.title,
    texteDeuxiemeLecture: getReadingText(html, 3),
    evangile: evangile.reference,
    titreEvangile: evangile.title,
    texteEvangile: getReadingText(html, 4),
    deuxiemeLectureDisponible: Boolean(deuxieme.reference)
  };
}
