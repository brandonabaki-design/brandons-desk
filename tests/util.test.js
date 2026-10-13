'use strict';

module.exports = async function (t) {
  await t.test('todayDubai across the UTC midnight boundary', (sb, assert) => {
    const { todayDubai } = sb.gs;
    assert.equal(todayDubai(new Date('2026-10-09T19:59:59Z')), '2026-10-09');
    assert.equal(todayDubai(new Date('2026-10-09T20:00:00Z')), '2026-10-10');
    assert.equal(todayDubai(new Date('2026-10-10T19:59:00Z')), '2026-10-10');
    assert.equal(todayDubai(new Date('2026-12-31T20:30:00Z')), '2027-01-01');
    assert.match(todayDubai(), /^\d{4}-\d{2}-\d{2}$/);
  });

  await t.test('todayDubai honours a fixed clock and the Config TIMEZONE', (sb, assert) => {
    assert.equal(sb.gs.todayDubai(), '2026-10-10');
    sb.mock.seed('Config', [['TIMEZONE', 'America/New_York', '']]);
    sb.gs.clearConfigMemo();
    assert.equal(sb.gs.todayDubai(), '2026-10-09');
  }, { now: '2026-10-09T21:00:00Z' });

  await t.test('formatDate / formatDateTime / parseDate round-trip in Dubai', (sb, assert) => {
    const { parseDate, formatDate, formatDateTime, toDateString, toDateTimeString, dateCell } = sb.gs;
    const d = parseDate('2026-10-10');
    assert.equal(d.toISOString(), '2026-10-09T20:00:00.000Z', 'midnight Dubai');
    assert.equal(formatDate(d), '2026-10-10');
    assert.equal(formatDate('2026-10-10', 'EEEE d MMMM yyyy'), 'Saturday 10 October 2026');
    assert.equal(formatDateTime(new Date('2026-10-10T02:40:12Z')), '2026-10-10T06:40:12+04:00');
    assert.equal(parseDate('2026-10-10T06:40:12+04:00').toISOString(), '2026-10-10T02:40:12.000Z');
    assert.equal(parseDate('2026-10-10 06:40').toISOString(), '2026-10-10T02:40:00.000Z', 'routine datetime is local');
    assert.equal(parseDate('2026-10-10T02:40:12Z').toISOString(), '2026-10-10T02:40:12.000Z');
    assert.equal(parseDate(''), null);
    assert.equal(parseDate('not a date'), null);
    assert.equal(parseDate('2026-13-40'), null);
    assert.equal(parseDate('2026-02-30'), null, 'impossible date is not rolled into March');
    assert.equal(parseDate('2026-04-31'), null);
    assert.equal(parseDate('2026-02-29'), null, '2026 is not a leap year');
    assert.equal(parseDate('2028-02-29').toISOString(), '2028-02-28T20:00:00.000Z', '2028 is');
    assert.equal(parseDate('2026-10-10 25:00'), null);
    // The Date.parse fallback needs an explicit four-digit year: V8 would otherwise resolve these to the year 2001.
    ['Oct 14', '14 Oct', 'Tue 14 Oct', '1', '14/10', 'next week', 'Oct'].forEach((s) => assert.equal(parseDate(s), null, JSON.stringify(s) + ' is not guessed as 2001'));
    assert.equal(toDateString(parseDate('14 Oct 2026')), '2026-10-14', 'an explicit year still parses');
    assert.equal(parseDate('Thu, 08 Oct 2026 06:00:00 GMT').toISOString(), '2026-10-08T06:00:00.000Z', 'RFC 2822 still parses');
    assert.equal(toDateString('Oct 14'), '');
    assert.equal(toDateString('2026-02-30'), '');
    assert.equal(toDateString('2026-04-31'), '');
    assert.equal(toDateString(new Date('2026-10-09T20:00:00Z')), '2026-10-10');
    assert.equal(toDateString('2026-10-10'), '2026-10-10');
    assert.equal(toDateString('2026-10-10 06:40'), '2026-10-10');
    assert.equal(toDateString(''), '');
    assert.equal(toDateTimeString(new Date('2026-10-10T02:40:12Z')), '2026-10-10T06:40:12+04:00');
    assert.equal(dateCell(''), '');
    assert.equal(dateCell('2026-10-10').toISOString(), '2026-10-09T20:00:00.000Z');
  });

  await t.test('addDays, daysBetween, isoWeekday, mondayOf', (sb, assert) => {
    const { addDays, daysBetween, isoWeekday, mondayOf } = sb.gs;
    assert.equal(addDays('2026-10-10', 1), '2026-10-11');
    assert.equal(addDays('2026-10-31', 1), '2026-11-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
    assert.equal(addDays('2024-03-01', -1), '2024-02-29');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(daysBetween('2026-10-01', '2026-10-10'), 9);
    assert.equal(daysBetween('2026-10-10', '2026-10-01'), -9);
    assert.equal(isoWeekday('2026-10-05'), 1, 'Monday');
    assert.equal(isoWeekday('2026-10-10'), 6, 'Saturday');
    assert.equal(isoWeekday('2026-10-11'), 7, 'Sunday');
    assert.equal(mondayOf('2026-10-05'), '2026-10-05');
    assert.equal(mondayOf('2026-10-08'), '2026-10-05');
    assert.equal(mondayOf('2026-10-11'), '2026-10-05');
    assert.equal(mondayOf('2026-10-12'), '2026-10-12');
  });

  await t.test('nextMeetingDate / weekOf / window for every weekday', (sb, assert) => {
    const { nextMeetingDate, mondayOf, agendaWindow, weekdayNumber } = sb.gs;
    const expected = {
      '2026-10-05': '2026-10-06', // Mon → Tue
      '2026-10-06': '2026-10-06', // Tue → same day
      '2026-10-07': '2026-10-13', // Wed
      '2026-10-08': '2026-10-13', // Thu
      '2026-10-09': '2026-10-13', // Fri
      '2026-10-10': '2026-10-13', // Sat
      '2026-10-11': '2026-10-13' // Sun
    };
    Object.keys(expected).forEach((day) => {
      assert.equal(nextMeetingDate(day, 'Tuesday'), expected[day], 'from ' + day);
      assert.equal(nextMeetingDate(day, 'tue'), expected[day]);
      assert.equal(nextMeetingDate(day, 2), expected[day]);
      assert.equal(mondayOf(expected[day]), expected[day] === '2026-10-06' ? '2026-10-05' : '2026-10-12');
    });
    assert.equal(nextMeetingDate('2026-10-07', 'Monday'), '2026-10-12');
    assert.equal(nextMeetingDate('2026-10-07', 'Sunday'), '2026-10-11');
    assert.equal(weekdayNumber('garbage'), 2, 'defaults to Tuesday');
    const win = agendaWindow('2026-10-13');
    assert.deepEqual(win, { meetingDate: '2026-10-13', weekOf: '2026-10-12', from: '2026-10-06', to: '2026-10-12' });
    const win2 = agendaWindow('2026-10-06');
    assert.deepEqual(win2, { meetingDate: '2026-10-06', weekOf: '2026-10-05', from: '2026-09-29', to: '2026-10-05' });
    assert.throws(() => agendaWindow('nope'), /Meeting date/);
  });

  await t.test('newId format, prefixes and uniqueness', (sb, assert) => {
    const { newId } = sb.gs;
    const seen = new Set();
    for (let i = 0; i < 500; i++) {
      const id = newId('W', seen);
      assert.match(id, /^W-[a-z0-9]{8}$/, id);
      assert.ok(!seen.has(id), 'duplicate ' + id);
      seen.add(id);
    }
    assert.match(newId('P'), /^P-[a-z0-9]{8}$/);
    assert.match(newId('I-', []), /^I-[a-z0-9]{8}$/, 'tolerates a prefix with the dash');
    // Collision avoidance: force the first two random draws to repeat, then check a new id comes out.
    const vmMath = sb.eval('Math');
    const origRandom = vmMath.random;
    let calls = 0;
    vmMath.random = () => { calls++; return calls <= 2 ? 0.123456789 : origRandom(); };
    const first = newId('W');
    const existing = new Set([first]);
    calls = 0;
    const second = newId('W', existing);
    vmMath.random = origRandom;
    assert.notEqual(second, first);
    assert.ok(/^W-[a-z0-9]{8}$/.test(second));
    assert.ok(calls > 2, 'had to draw again after the collision');
  }, { now: '2026-10-08T06:00:00Z' }); // fixed clock: the id also mixes in Date.now(), so a millisecond tick between the two calls must not break the forced collision

  await t.test('normaliseTitle', (sb, assert) => {
    const { normaliseTitle } = sb.gs;
    assert.equal(normaliseTitle('  Re: FWD: Re:  Lab   Timetable!!  '), 'lab timetable');
    assert.equal(normaliseTitle('Email parents (about) the robotics-club.'), 'email parents about the robotics club');
    assert.equal(normaliseTitle('Café déjà-vu'), 'café déjà vu');
    assert.equal(normaliseTitle(''), '');
    assert.equal(normaliseTitle(null), '');
  });

  await t.test('diceSimilarity and isSimilarTitle thresholds', (sb, assert) => {
    const { diceSimilarity, isSimilarTitle } = sb.gs;
    assert.equal(diceSimilarity('a b c', 'a b c'), 1);
    assert.equal(diceSimilarity('a b c d', 'e f g h'), 0);
    assert.ok(Math.abs(diceSimilarity('email parents about the robotics club', 'email parents about robotics club') - 10 / 11) < 1e-9);
    assert.ok(isSimilarTitle('Re: Lab timetable', 'lab timetable'), 'normalised equal');
    assert.ok(isSimilarTitle('Email parents about the robotics club', 'Email parents about robotics club'), 'dice 0.91');
    assert.ok(!isSimilarTitle('Buy milk', 'Buy milk today'), 'fewer than 3 words on one side');
    assert.ok(!isSimilarTitle('Plan the AI workshop', 'Plan the science fair'), 'dice 0.5');
    assert.ok(isSimilarTitle('Book the lab for Monday', 'Book the lab for Tuesday'), '4 of 5 words shared → 2*4/10 = 0.8 (inclusive)');
    assert.ok(!isSimilarTitle('Book the lab for Monday morning', 'Book the lab for Tuesday afternoon'), '4 of 6 shared → 0.67');
    assert.ok(isSimilarTitle('Send agenda to director tonight', 'Send agenda to director'), '2*4/9 = 0.89');
    assert.ok(!isSimilarTitle('', 'anything'));
  });

  await t.test('keywordHit: whole words and multi-word phrases', (sb, assert) => {
    const { keywordHit, matchedKeyword } = sb.gs;
    const kws = ['AI', 'AI Learning Hub', 'newsletter', 'ChatGPT', 'PD'];
    assert.ok(keywordHit('Plan the AI workshop', kws));
    assert.ok(keywordHit('plan the ai workshop', kws), 'case-insensitive');
    assert.ok(!keywordHit('She said it was fine', kws), '"said" is not "AI"');
    assert.ok(!keywordHit('Aim for the stars', kws));
    assert.ok(!keywordHit('Update the PDF', kws), '"PDF" is not "PD"');
    assert.ok(keywordHit('Run a PD session', kws));
    assert.ok(keywordHit('Write the ai   learning hub intro', kws), 'phrase across extra spaces');
    assert.equal(matchedKeyword('Write the AI Learning Hub intro', ['AI Learning Hub']), 'AI Learning Hub');
    assert.ok(keywordHit('Newsletter: October', kws), 'punctuation boundary');
    assert.ok(keywordHit('(ChatGPT)', kws));
    assert.ok(!keywordHit('', kws));
    assert.ok(!keywordHit('anything', []));
    assert.ok(!keywordHit('anything', ['', '  ']));
    assert.ok(keywordHit('C++ course', ['c++']), 'regex characters are escaped');
  });

  await t.test('sha1Hex', (sb, assert) => {
    assert.equal(sb.gs.sha1Hex('abc'), 'a9993e364706816aba3e25717850c26c9cd0d89d');
    assert.equal(sb.gs.sha1Hex(''), 'da39a3ee5e6b4b0d3255bfef95601890afd80709');
    const crypto = require('node:crypto');
    assert.equal(sb.gs.sha1Hex('café'), crypto.createHash('sha1').update('café', 'utf8').digest('hex'), 'UTF-8 bytes');
    assert.equal(sb.gs.sha1Hex('email sara|2026-10-07'), crypto.createHash('sha1').update('email sara|2026-10-07').digest('hex'));
  });

  await t.test('extractEmail / extractDisplayName', (sb, assert) => {
    const { extractEmail, extractDisplayName } = sb.gs;
    assert.equal(extractEmail('Sara Khan <Sara.Khan@aisa.sch.ae>'), 'sara.khan@aisa.sch.ae');
    assert.equal(extractEmail('"Khan, Sara" <sara@aisa.sch.ae>'), 'sara@aisa.sch.ae');
    assert.equal(extractEmail('bbaki@aisa.sch.ae'), 'bbaki@aisa.sch.ae');
    assert.equal(extractEmail('  BBAKI@AISA.SCH.AE '), 'bbaki@aisa.sch.ae');
    assert.equal(extractEmail(''), '');
    assert.equal(extractDisplayName('Sara Khan <sara@aisa.sch.ae>'), 'Sara Khan');
    assert.equal(extractDisplayName('"Google Chat" <chat-noreply@google.com>'), 'Google Chat');
    assert.equal(extractDisplayName('sara@aisa.sch.ae'), '');
  });

  await t.test('stripQuotedReply', (sb, assert) => {
    const { stripQuotedReply } = sb.gs;
    const body = 'Hi Brandon,\n\nCould you send the timetable?\n\nThanks\n\nOn Thu, Oct 8, 2026 at 9:00 AM Brandon <bbaki@aisa.sch.ae>\nwrote:\n> old text\n> more';
    assert.equal(stripQuotedReply(body), 'Hi Brandon,\n\nCould you send the timetable?\n\nThanks');
    assert.equal(stripQuotedReply('Line one\n> quoted\nLine two\r\n> quoted again'), 'Line one\nLine two');
    assert.equal(stripQuotedReply('Reply\n\n-----Original Message-----\nFrom: x\nSent: y\nbody'), 'Reply');
    assert.equal(stripQuotedReply('Top\n\nFrom: Someone <s@x.com>\nSent: Monday\nTo: me\nSubject: hi\n\nold'), 'Top');
    assert.equal(stripQuotedReply(''), '');
    assert.equal(stripQuotedReply('No quote here. On balance it is fine.'), 'No quote here. On balance it is fine.');
  });

  await t.test('sanitiseLink and cleanSnippet', (sb, assert) => {
    const { sanitiseLink, cleanSnippet } = sb.gs;
    assert.equal(sanitiseLink('https://example.com/a?b=1'), 'https://example.com/a?b=1');
    assert.equal(sanitiseLink('  HTTP://example.com '), 'HTTP://example.com');
    assert.equal(sanitiseLink('javascript:alert(1)'), '');
    assert.equal(sanitiseLink('JavaScript:alert(1)'), '');
    assert.equal(sanitiseLink('data:text/html,hi'), '');
    assert.equal(sanitiseLink('vbscript:x'), '');
    assert.equal(sanitiseLink('//evil.com'), '');
    assert.equal(sanitiseLink('ftp://x'), '');
    assert.equal(sanitiseLink(''), '');
    assert.equal(sanitiseLink(null), '');
    assert.equal(sanitiseLink('https://x.com/a"onclick="x'), 'https://x.com/aonclick=x');
    assert.equal(sanitiseLink('https://x.com/a\u0001b\u007fc\u001fd'), 'https://x.com/abcd', 'control characters are dropped too');
    const long = 'word '.repeat(200);
    assert.equal(cleanSnippet(long).length, 400);
    assert.equal(cleanSnippet('  a \n\n b\t c  '), 'a b c');
  });

  await t.test('decodeEntities', (sb, assert) => {
    const { decodeEntities } = sb.gs;
    assert.equal(decodeEntities('Mum &amp; Dad &lt;3 &quot;hi&quot; &#39;x&#39; &#x41; &nbsp;y &unknown;'), 'Mum & Dad <3 "hi" \'x\' A  y &unknown;');
  });

  await t.test('log() writes to the Log tab, mirrors to Logger and trims at 2000 rows', (sb, assert) => {
    sb.gs.log('unit', 'INFO', 'hello');
    sb.gs.log('unit', 'bogus', 'level falls back to INFO');
    let rows = sb.mock.logRows();
    assert.equal(rows.length, 2);
    assert.equal(rows[0].fn, 'unit');
    assert.equal(rows[0].level, 'INFO');
    assert.equal(rows[0].message, 'hello');
    assert.ok(Object.prototype.toString.call(rows[0].time) === '[object Date]');
    assert.equal(rows[1].level, 'INFO');
    assert.ok(sb.mock.logs.some((l) => l.includes('hello')));
    // Trim: fill to 2001 rows then log once more → 1500 newest remain.
    const sheet = sb.mock.sheet('Log');
    sheet.maxRows = 5000;
    const filler = [];
    for (let i = rows.length; i < 2001; i++) filler.push([new Date(), 'fill', 'INFO', 'row ' + i]);
    sheet.getRange(sheet.getLastRow() + 1, 1, filler.length, 4).setValues(filler);
    sb.gs.log('unit', 'WARN', 'last one');
    rows = sb.mock.logRows();
    assert.equal(rows.length, 1500);
    assert.equal(rows[rows.length - 1].message, 'last one');
    assert.equal(rows[0].message, 'row 502');
  });

  await t.test('userError flags and errorMessage shortens', (sb, assert) => {
    const e = sb.gs.userError('Nope');
    assert.equal(e.isUserError, true);
    assert.equal(e.message, 'Nope');
    assert.equal(sb.gs.errorMessage(new Error('x'.repeat(500))).length, 200);
    assert.equal(sb.gs.errorMessage(null), 'Unknown error');
    assert.equal(sb.gs.errorMessage('plain string'), 'plain string');
  });
};
