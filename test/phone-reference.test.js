// The phone-number reference table of the corbit-phone-numbers skill (reference.md), row by row,
// "plugins (international)" column. Run `npm run build` first, then `npm test`.
// Invisible characters are written as \u escapes so this file holds none.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CorbitSms } = require('../dist/nodes/CorbitSms/CorbitSms.node.js');
const G = require('../dist/nodes/CorbitSms/GenericFunctions.js');

const SA = '966501234567';
// test titles show the invisible marks as \u escapes
const MARKS = /[\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff]/g;
const show = (v) => JSON.stringify(v).replace(MARKS, (c) => '\\u' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));

// ---------- reference.md: one number ----------
const ACCEPTED = [
	['0501234567', SA], // Saudi local
	['501234567', SA], // without the 0
	['966501234567', SA],
	['+966501234567', SA],
	['00966501234567', SA],
	['+966 50 123 4567', SA], // spaces, as copied from phone contacts
	['+966 (0)50 123 4567', SA], // trunk (0) after the country code is dropped
	['٠٥٠١٢٣٤٥٦٧', SA], // Arabic-Indic digits
	['۰۵۰۱۲۳۴۵۶۷', SA], // Persian digits
	['+971501234567', '971501234567'],
	['00971501234567', '971501234567'],
	['971501234567', '971501234567'],
	['+53 512345678', '53512345678'], // "+" with another code never becomes Saudi
	[966501234567, SA], // a safe integer (number type)
	['+1 (202) 555-0123', '12025550123'], // a bracket in the middle is allowed
	['(+966) 50 123 4567', SA], // a bracket at the start is allowed
	['\u202a0501234567\u202c', SA], // direction marks from copying are removed
	['\u2066+966 50 123 4567\u2069', SA], // direction isolates (Android) are removed
	['0501234567\u200b', SA], // zero-width space is removed
	['\u061c0501234567', SA], // Arabic letter mark is removed
	['+44 020 7946 0958', '4402079460958'], // a trunk 0 without brackets after another code is kept on purpose
	['+971 50 (123) 4567', '971501234567'], // a balanced bracket in the middle is allowed
];

const REFUSED = [
	'0123456789', // local number of an unknown country
	'07911123456', // local number of an unknown country
	'96650123456', // one digit short after 9665
	'9665012345678', // one digit too many after 9665
	'966501234567.0', // decimal value
	'+966501234567.0', // decimal value with +
	'+971501234567.0', // the dot must not be dropped: it would become the wrong number 9715012345670
	'05.01234567', // a dot is not a separator
	'966.501.234.567', // a dot is not a separator
	'9.66501E+11', // scientific notation from Excel (as text)
	966501234567.5, // a number that is not an integer
	'0501234567 ext 12', // letters
	'+971501234567 (1)', // bracket at the end: dropping it gives 9715012345671, someone else
	'+971 4 123 4567 (101)', // extension in brackets at the end
	'0501234567 (1)', // bracket at the end
	'+971 4 123 4567 (1-01)', // bracket at the end with a dash: the first rule gave 97141234567101
	'+971501234567 (1)-', // a dash after the last bracket
	'+971501234567 (1) -', // a space and a dash after the last bracket
	'+971501234567 (1', // a bracket without its pair
	'+971501234567 1)', // a bracket without its pair
	'((+966) 50 123 4567', // brackets that do not pair up
	'+966 (50 123 4567', // brackets that do not pair up
	'+971501234567 ((1))', // nested brackets: the second rule gave 9715012345671
	'(+971501234567 (1))', // nested brackets
	'+971501234567 (1)(2)', // bracket at the end
	'abc',
	'',
	null,
];

for (const [raw, want] of ACCEPTED) {
	test(`reference: ${show(raw)} -> ${want}`, () => {
		assert.equal(G.normalizeNumber(raw), want);
	});
}

for (const raw of REFUSED) {
	test(`reference: ${show(raw)} is refused`, () => {
		assert.equal(G.normalizeNumber(raw), undefined);
	});
}

test('reference: "(0)" after a digit that is not a country code never makes a UAE number', () => {
	const r = G.normalizeNumber('+9(0)71501234567');
	assert.ok(r === undefined || r === '9071501234567', String(r));
	assert.notEqual(r, '971501234567');
});

// ---------- reference.md: splitting a list ----------
test('reference: list splitting', () => {
	assert.deepEqual(G.splitNumbers('+966 50 123 4567'), ['+966501234567']);
	assert.deepEqual(G.splitNumbers('0501234567 0509876543'), ['0501234567', '0509876543']);
	assert.deepEqual(G.splitNumbers('0501234567،0509876543؛0551234567'), ['0501234567', '0509876543', '0551234567']);
	assert.deepEqual(G.splitNumbers('0501234567\t0509876543'), ['0501234567', '0509876543']);
	assert.deepEqual(G.splitNumbers('0501234567\n0509876543'), ['0501234567', '0509876543']);
	const mixed = G.splitNumbers('abc 0501234567');
	assert.deepEqual(mixed, ['abc', '0501234567']);
	assert.equal(G.normalizeNumber(mixed[0]), undefined, 'abc is refused');
	assert.deepEqual(G.splitNumbers('+966 50 123 4567, 05 0123 4567'), ['+966501234567', '0501234567']);
});

test('reference: list splitting removes the invisible marks before reading a piece', () => {
	assert.deepEqual(G.splitNumbers('\u2066+966 50 123 4567\u2069, \u202a0551234567\u202c'), ['+966501234567', '0551234567']);
});

test('reference: a bracket note at the end of a list piece is never joined into a number', () => {
	const tokens = G.splitNumbers('+971501234567 (1), 0501234567');
	assert.ok(!tokens.map((t) => G.normalizeNumber(t)).includes('9715012345671'), JSON.stringify(tokens));
	assert.ok(tokens.some((t) => G.normalizeNumber(t) === undefined), 'the piece with "(1)" is refused');
});

function ctx(params) {
	const calls = [];
	return {
		calls,
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'Corbit SMS', type: 'n8n-nodes-corbit-sms.corbitSms', typeVersion: 1, parameters: {} }),
		getCredentials: async () => ({ apiToken: 'TEST', baseUrl: 'https://api.corbit.sa' }),
		continueOnFail: () => false,
		helpers: {
			httpRequestWithAuthentication: async (cred, options) => {
				calls.push(options);
				return { statusCode: 200, body: { status: 'Success', data: { message: { id: 'b1', status: 'pending' } } }, headers: {} };
			},
		},
	};
}

test('reference: "0501234567, 966501234567" is sent as one number', async () => {
	const c = ctx({ resource: 'sms', operation: 'sendBulk', senderName: 'S', numbers: '0501234567, 966501234567', message: 'hi', options: {} });
	await new CorbitSms().execute.call(c);
	assert.deepEqual(c.calls[0].body.numbers, [SA]);
});

test('reference: a bulk list with "+971501234567 (1)" sends nothing', async () => {
	const c = ctx({ resource: 'sms', operation: 'sendBulk', senderName: 'S', numbers: '+971501234567 (1), 0501234567', message: 'hi', options: {} });
	await assert.rejects(new CorbitSms().execute.call(c), /invalid mobile numbers/);
	assert.equal(c.calls.length, 0);
});

test('reference: list pieces with a dashed or unpaired bracket at the end are refused, never joined', () => {
	for (const piece of ['+971 4 123 4567 (1-01)', '+971501234567 (1)-', '+971501234567 (1) -', '+971501234567 (1', '+971501234567 1)', '+971501234567 ((1))', '(+971501234567 (1))']) {
		const numbers = G.splitNumbers(piece + ', 0501234567').map((t) => G.normalizeNumber(t));
		assert.ok(numbers.includes(undefined), piece);
		assert.ok(!numbers.includes('97141234567101') && !numbers.includes('9715012345671'), piece);
	}
});
