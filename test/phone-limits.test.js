// Review fixes of 2026-11-20 (corbit-phone-numbers rule 3): length limits, a bracket at the start
// only around a country code, direction overrides refused, and no slow regex on long input.
// Run `npm run build` first, then `npm test`. Invisible characters are written as \u escapes.
const test = require('node:test');
const assert = require('node:assert/strict');
const G = require('../dist/nodes/CorbitSms/GenericFunctions.js');

const SA = '966501234567';

test('a bracket at the start around a country code is formatting', () => {
	assert.equal(G.normalizeNumber('(+966) 50 123 4567'), SA);
	assert.equal(G.normalizeNumber('(00966) 50 123 4567'), SA);
	assert.equal(G.normalizeNumber('( +966 ) 50 123 4567'), SA);
	assert.equal(G.normalizeNumber('(050) 123 4567'), SA);
	assert.equal(G.normalizeNumber('+1 (202) 555-0123'), '12025550123');
});

test('a bracket at the start around a whole number is refused (it would become someone else)', () => {
	for (const raw of ['(+971501234567) 1', '( +971501234567) 1', '(+971501234567)1', '(971501234567) 1', '(+97150) 1234567']) {
		assert.equal(G.normalizeNumber(raw), undefined, raw);
	}
});

test('direction overrides are refused, other direction marks are removed', () => {
	assert.equal(G.normalizeNumber('\u202e7654321050'), undefined);
	assert.equal(G.normalizeNumber('\u202d0501234567'), undefined);
	assert.equal(G.normalizeNumber('0501234567\u202e'), undefined);
	assert.equal(G.normalizeNumber('\u202a0501234567\u202c'), SA);
	assert.equal(G.normalizeNumber('\u202b0501234567\u202c'), SA);
	assert.deepEqual(G.splitNumbers('\u202e7654321050').map(G.normalizeNumber), [undefined]);
});

test('a number is at most 40 characters once the marks are removed, and 200 with them', () => {
	const at40 = '+966' + ' -'.repeat(13) + '501234567' + ' '; // trimmed to 39
	assert.equal(G.normalizeNumber('+966' + ' -'.repeat(12) + '50123456' + '7'), SA); // 37
	assert.equal(G.normalizeNumber(at40), SA);
	const exactly40 = '+966-' + '-'.repeat(26) + '501234567';
	assert.equal(exactly40.length, 40);
	assert.equal(G.normalizeNumber(exactly40), SA);
	assert.equal(G.normalizeNumber('+966-' + '-'.repeat(27) + '501234567'), undefined); // 41
	const marked = '0501234567' + '\u200b'.repeat(190);
	assert.equal(marked.length, 200);
	assert.equal(G.normalizeNumber(marked), SA);
	assert.equal(G.normalizeNumber(marked + '\u200b'), undefined);
});

test('long input is refused quickly (no slow regex)', () => {
	const start = Date.now();
	assert.equal(G.normalizeNumber('('.repeat(200000) + 'x'), undefined);
	assert.equal(G.normalizeNumber('( ' + ' '.repeat(200000) + 'x'), undefined);
	assert.equal(G.normalizeNumber(' '.repeat(200000) + 'x'), undefined);
	const pieces = G.splitNumbers('( ' + ' '.repeat(100000) + 'x');
	assert.deepEqual(pieces, ['(', 'x']);
	G.splitNumbers('1 '.repeat(100000) + 'x');
	assert.ok(Date.now() - start < 1000, `took ${Date.now() - start} ms`);
});

test('a list keeps "(+966) 50 123 4567" as one number', () => {
	const pieces = G.splitNumbers('(+966) 50 123 4567, 0509876543');
	assert.equal(pieces.length, 2);
	assert.deepEqual(pieces.map(G.normalizeNumber), [SA, '966509876543']);
});

test('the error for a bad To number shows at most 60 characters', async () => {
	const { CorbitSms } = require('../dist/nodes/CorbitSms/CorbitSms.node.js');
	const long = '+971501234567 ' + 'x'.repeat(500);
	const ctx = {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) =>
			({ resource: 'sms', operation: 'send', senderName: 'OT.SA', to: long, message: 'hi', options: {} })[name] ?? fallback,
		getNode: () => ({ name: 'Corbit SMS', type: 'n8n-nodes-corbit-sms.corbitSms', typeVersion: 1, parameters: {} }),
		continueOnFail: () => false,
		helpers: { httpRequestWithAuthentication: async () => assert.fail('no request expected') },
	};
	await assert.rejects(new CorbitSms().execute.call(ctx), (e) => e.message.length < 120);
});
