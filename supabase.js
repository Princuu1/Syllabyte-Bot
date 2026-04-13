require('dotenv').config();
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_KEY
);

// 🔥 Your buckets (subjects)
const SUBJECTS = ['BEEE', 'MATH', 'CHEMISTRY', 'WT', 'UHV']; // add all buckets

// 📚 Get subjects
async function getSubjects() {
  return SUBJECTS.map(s => s.toLowerCase());
}

// 📄 Get files in subject
async function getFiles(subject) {
  const bucket = subject.toUpperCase();

  const { data, error } = await supabase.storage
    .from(bucket)
    .list('', { limit: 100 });

  if (error) throw error;

  return (data || []).filter(f => f.name.toLowerCase().endsWith('.pdf'));
}

// 🔍 Search file in ALL buckets
async function searchFile(fileName) {
  const subjects = await getSubjects();

  for (const subject of subjects) {
    const files = await getFiles(subject);

    const found = files.find(f =>
      f.name.toLowerCase().replace('.pdf', '') === fileName
    );

    if (found) {
      return { subject, file: found.name };
    }
  }

  return null;
}

// 🔗 Public URL
function getPublicUrl(subject, fileName) {
  return `${process.env.SUPABASE_URL}/storage/v1/object/public/${subject.toUpperCase()}/${encodeURIComponent(fileName)}`;
}

module.exports = {
  getSubjects,
  getFiles,
  searchFile,
  getPublicUrl
};