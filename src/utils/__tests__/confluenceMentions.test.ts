import {
  extractMentionIdsFromHtml,
  parseMentionInput,
  mentionsPresentInText,
  newlyMentioned,
  MAX_MENTIONS_PER_ITEM
} from '../confluenceMentions';

const A = 'aaaaaaaaaaaaaaaaaaaaaaaa';
const B = 'bbbbbbbbbbbbbbbbbbbbbbbb';
const span = (id: string, label = 'X') => `<span data-type="mention" data-id="${id}" data-label="${label}">@${label}</span>`;

describe('extractMentionIdsFromHtml', () => {
  it('reads user ids from mention spans, de-duplicated, in order', () => {
    expect(extractMentionIdsFromHtml(`<p>${span(B)} and ${span(A)} and ${span(B)}</p>`)).toEqual([B, A]);
  });
  it('accepts attributes in any order', () => {
    expect(extractMentionIdsFromHtml(`<span data-id="${A}" data-label="P" data-type="mention">@P</span>`)).toEqual([A]);
  });
  it('ignores other spans and malformed ids', () => {
    expect(extractMentionIdsFromHtml(`<span style="color:#f00">x</span><span data-type="mention" data-id="not-an-id">@x</span>`)).toEqual([]);
    expect(extractMentionIdsFromHtml(`<span data-type="other" data-id="${A}">x</span>`)).toEqual([]);
  });
  it('handles empty input and caps the count', () => {
    expect(extractMentionIdsFromHtml('')).toEqual([]);
    expect(extractMentionIdsFromHtml(null)).toEqual([]);
    const many = Array.from({ length: 80 }, (_, i) => span(i.toString(16).padStart(24, '0'))).join('');
    expect(extractMentionIdsFromHtml(many)).toHaveLength(MAX_MENTIONS_PER_ITEM);
  });
});

describe('parseMentionInput', () => {
  it('accepts [{ userId }] or [id], de-duplicated, valid ids only', () => {
    expect(parseMentionInput([{ userId: A }, B, { userId: A }, 'nope', 42, null, {}])).toEqual([A, B]);
  });
  it('treats anything else as no mentions', () => {
    expect(parseMentionInput(undefined)).toEqual([]);
    expect(parseMentionInput('aaa')).toEqual([]);
  });
});

describe('mentionsPresentInText', () => {
  const users = [{ _id: A, displayName: 'Priya Shah' }, { _id: B, displayName: 'Vicky' }];
  it('keeps users whose "@Name" appears (case-insensitive)', () => {
    expect(mentionsPresentInText('@priya shah please review', users)).toEqual([A]);
    expect(mentionsPresentInText('@Priya Shah and @Vicky', users)).toEqual([A, B]);
  });
  it('drops users whose mention text was removed', () => {
    expect(mentionsPresentInText('Priya Shah, no at-sign', users)).toEqual([]);
  });
  it('ignores users without a display name', () => {
    expect(mentionsPresentInText('@', [{ _id: A, displayName: '' }])).toEqual([]);
  });
});

describe('newlyMentioned', () => {
  it('returns only ids that were not mentioned before, excluding the actor', () => {
    expect(newlyMentioned([A], [A, B])).toEqual([B]);
    expect(newlyMentioned([], [A, B], A)).toEqual([B]);
    expect(newlyMentioned([A, B], [A])).toEqual([]);
  });
  it('compares case-insensitively', () => {
    expect(newlyMentioned([A.toUpperCase()], [A])).toEqual([]);
  });
});
