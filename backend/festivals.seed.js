// Major pan-India festival calendar — seeded once into the `festivals` table.
//
// ⚠️ IMPORTANT: Lunar / regional festival dates SHIFT every year and vary by
// region. The 2026 Gregorian dates below are best-effort and MUST be verified
// by an admin against an official panchang/calendar before going live, and
// re-seeded each year. Fixed national holidays (Republic/Independence/Gandhi
// Jayanti/New Year/Christmas) are reliable.
//
// Each festival: name, date (YYYY-MM-DD), greeting, emoji, accent_color, template_id.

const FESTIVALS_2026 = [
    { name: "New Year's Day",        date: '2026-01-01', greeting: 'Wishing you a healthy & happy New Year!',          emoji: '🎉', accent: '#3B82F6', template: 'festive-classic' },
    { name: 'Makar Sankranti',       date: '2026-01-14', greeting: 'Happy Makar Sankranti! May your life soar high.',  emoji: '🪁', accent: '#F59E0B', template: 'festive-classic' },
    { name: 'Pongal',                date: '2026-01-15', greeting: 'Happy Pongal! Wishing you health & prosperity.',    emoji: '🌾', accent: '#16A34A', template: 'elegant-band' },
    { name: 'Republic Day',          date: '2026-01-26', greeting: 'Happy Republic Day! 🇮🇳',                           emoji: '🇮🇳', accent: '#FF9933', template: 'elegant-band' },
    { name: 'Maha Shivaratri',       date: '2026-02-15', greeting: 'Har Har Mahadev. Blessings on Maha Shivaratri.',    emoji: '🕉️', accent: '#6D28D9', template: 'elegant-band' },
    { name: 'Holi',                  date: '2026-03-04', greeting: 'Happy Holi! May your life be full of colours.',     emoji: '🎨', accent: '#EC4899', template: 'festive-classic' },
    { name: 'Ugadi / Gudi Padwa',    date: '2026-03-19', greeting: 'Happy Ugadi! A fresh year of good health ahead.',   emoji: '🌸', accent: '#F59E0B', template: 'festive-classic' },
    { name: 'Eid al-Fitr',           date: '2026-03-21', greeting: 'Eid Mubarak! Peace and happiness to your family.',  emoji: '🌙', accent: '#0EA5E9', template: 'elegant-band' },
    { name: 'Ram Navami',            date: '2026-03-26', greeting: 'Jai Shri Ram. Blessings on Ram Navami.',            emoji: '🙏', accent: '#EA580C', template: 'elegant-band' },
    { name: 'Baisakhi',              date: '2026-04-14', greeting: 'Happy Baisakhi! A harvest of good health to you.',   emoji: '🌾', accent: '#F59E0B', template: 'festive-classic' },
    { name: 'Buddha Purnima',        date: '2026-05-01', greeting: 'Peace & compassion on Buddha Purnima.',             emoji: '☸️', accent: '#D97706', template: 'elegant-band' },
    { name: 'Eid al-Adha (Bakrid)',  date: '2026-05-27', greeting: 'Eid Mubarak! Blessings to you and your family.',    emoji: '🌙', accent: '#0EA5E9', template: 'elegant-band' },
    { name: 'Independence Day',      date: '2026-08-15', greeting: 'Happy Independence Day! 🇮🇳',                        emoji: '🇮🇳', accent: '#FF9933', template: 'elegant-band' },
    { name: 'Raksha Bandhan',        date: '2026-08-28', greeting: 'Happy Raksha Bandhan! Celebrating bonds of care.',  emoji: '🧵', accent: '#E11D48', template: 'festive-classic' },
    { name: 'Janmashtami',           date: '2026-09-04', greeting: 'Happy Janmashtami! Krishna’s blessings to you.',    emoji: '🦚', accent: '#2563EB', template: 'elegant-band' },
    { name: 'Ganesh Chaturthi',      date: '2026-09-14', greeting: 'Ganpati Bappa Morya! Wishing you good health.',     emoji: '🐘', accent: '#DC2626', template: 'festive-classic' },
    { name: 'Gandhi Jayanti',        date: '2026-10-02', greeting: 'Remembering Bapu on Gandhi Jayanti.',               emoji: '🕊️', accent: '#64748B', template: 'elegant-band' },
    { name: 'Navratri',              date: '2026-10-11', greeting: 'Happy Navratri! Nine nights of joy & energy.',      emoji: '🪔', accent: '#DB2777', template: 'festive-classic' },
    { name: 'Dussehra',              date: '2026-10-20', greeting: 'Happy Dussehra! May good triumph in your life.',    emoji: '🏹', accent: '#B45309', template: 'festive-classic' },
    { name: 'Karva Chauth',          date: '2026-10-29', greeting: 'Happy Karva Chauth! Health & togetherness.',        emoji: '🌝', accent: '#BE123C', template: 'elegant-band' },
    { name: 'Diwali',                date: '2026-11-08', greeting: 'Happy Diwali! Wishing you light, health & joy.',    emoji: '🪔', accent: '#E8A33D', template: 'festive-classic' },
    { name: 'Bhai Dooj',             date: '2026-11-11', greeting: 'Happy Bhai Dooj! Celebrating the bond of siblings.', emoji: '🪔', accent: '#F59E0B', template: 'festive-classic' },
    { name: 'Chhath Puja',           date: '2026-11-15', greeting: 'Happy Chhath Puja! Blessings of the Sun God.',      emoji: '🌅', accent: '#EA580C', template: 'elegant-band' },
    { name: 'Guru Nanak Jayanti',    date: '2026-11-24', greeting: 'Blessings on Guru Nanak Jayanti.',                  emoji: '🙏', accent: '#F59E0B', template: 'elegant-band' },
    { name: 'Christmas',             date: '2026-12-25', greeting: 'Merry Christmas! Warm wishes to your family.',      emoji: '🎄', accent: '#DC2626', template: 'festive-classic' },
];

function seedFestivals(db) {
    console.log(`[Seed] Inserting ${FESTIVALS_2026.length} festivals into calendar...`);
    const stmt = db.prepare(
        `INSERT OR IGNORE INTO festivals (name, festival_date, greeting, emoji, accent_color, template_id, region) VALUES (?, ?, ?, ?, ?, ?, 'IN')`
    );
    for (const f of FESTIVALS_2026) {
        stmt.run([f.name, f.date, f.greeting, f.emoji, f.accent, f.template]);
    }
    stmt.finalize();
    console.log('[Seed] Festival calendar seeded. NOTE: verify lunar dates before going live.');
}

module.exports = { seedFestivals, FESTIVALS_2026 };
