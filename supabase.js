require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');
const stringSimilarity = require('string-similarity');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

function getSubjects() {
  return (process.env.SUBJECT_BUCKETS || '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
}

async function getFiles(subject) {
  const bucket = subject.toUpperCase();

  const { data, error } = await supabase.storage
    .from(bucket)
    .list('', { limit: 100 });

  if (error) {
    console.error(`Supabase list error for bucket ${bucket}:`, error);
    return [];
  }

  return (data || []).filter((f) => f?.name && f.name.toLowerCase().endsWith('.pdf'));
}

function normalizeText(text) {
  return String(text || '')
    .toLowerCase()
    .replace(/[_-]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function romanToNumber(token) {
  const map = {
    i: '1',
    ii: '2',
    iii: '3',
    iv: '4',
    v: '5',
    vi: '6',
    vii: '7',
    viii: '8',
    ix: '9',
    x: '10',
  };
  return map[String(token || '').toLowerCase()] || null;
}

function extractFileUnitFromName(fileName) {
  const normalized = normalizeText(fileName).replace(/\.pdf$/i, '');

  const match = normalized.match(
    /\b(?:unit|module)\s*[- ]?\s*(\d+|i{1,3}|iv|v|vi{0,3}|ix|x)\b/i
  );

  if (!match) return null;

  const token = match[1].toLowerCase();
  if (/^\d+$/.test(token)) return token;
  return romanToNumber(token) || token;
}

function cleanQueryForSimilarity(query) {
  return normalizeText(query)
    .replace(/\bunit\b/g, '')
    .replace(/\bmodule\b/g, '')
    .replace(/\bnotes?\b/g, '')
    .replace(/\bpyq\b/g, '')
    .replace(/\blab\b/g, '')
    .replace(/\bfile\b/g, '')
    .replace(/\bpdf\b/g, '')
    .replace(/\bassignment\b/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function searchFile(query, opts = {}) {
  const subjects = getSubjects();
  const requestedSubject = (opts.subject || '').toLowerCase().trim();
  const requestedUnit = (opts.unit || '').toString().trim();
  const requestedType = (opts.type || '').toLowerCase().trim();

  const subjectsToSearch = requestedSubject && subjects.includes(requestedSubject)
    ? [requestedSubject]
    : subjects;

  for (const subject of subjectsToSearch) {
    const files = await getFiles(subject);
    if (!files.length) continue;

    if (requestedUnit) {
      const unitMatches = files.filter((f) => extractFileUnitFromName(f.name) === requestedUnit);

      if (unitMatches.length) {
        if (requestedType) {
          const typed = unitMatches.find((f) => f.name.toLowerCase().includes(requestedType));
          if (typed) return { subject, file: typed.name };
        }
        return { subject, file: unitMatches[0].name };
      }
    }

    if (requestedType) {
      const typeMatches = files.filter((f) => f.name.toLowerCase().includes(requestedType));
      if (typeMatches.length) {
        if (requestedUnit) {
          const exact = typeMatches.find((f) => extractFileUnitFromName(f.name) === requestedUnit);
          if (exact) return { subject, file: exact.name };
        }
        return { subject, file: typeMatches[0].name };
      }
    }

    const cleanedQuery = cleanQueryForSimilarity(query);
    const names = files.map((f) => f.name.toLowerCase().replace(/\.pdf$/i, ''));
    const match = stringSimilarity.findBestMatch(cleanedQuery, names);

    if (match.bestMatch && match.bestMatch.rating > 0.3) {
      return { subject, file: files[match.bestMatchIndex].name };
    }
  }

  return null;
}

function getPublicUrl(subject, fileName) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${subject.toUpperCase()}/${encodeURIComponent(fileName)}`;
}

module.exports = {
  getSubjects,
  getFiles,
  searchFile,
  getPublicUrl,
};
