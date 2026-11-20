// A lost connection during a send must not look safe to repeat: in the live test of 2026-11-20
// the connection dropped (ECONNRESET) after Corbit SMS had accepted and charged the SMS.
// Run `npm run build` first, then `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { CorbitSms } = require('../dist/nodes/CorbitSms/CorbitSms.node.js');

function ctx(params) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => ({ name: 'Corbit SMS', type: 'n8n-nodes-corbit-sms.corbitSms', typeVersion: 1, parameters: {} }),
		continueOnFail: () => false,
		getCredentials: async () => ({ apiToken: 't', baseUrl: 'https://api.corbit.sa' }),
		helpers: {
			httpRequestWithAuthentication: async () => {
				throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
			},
		},
	};
}

for (const [operation, extra] of [
	['send', { to: '0501234567' }],
	['sendBulk', { numbers: '0501234567, 0509876543' }],
]) {
	test(`${operation}: a lost connection says the SMS may have been sent`, async () => {
		const params = { resource: 'sms', operation, senderName: 'OT.SA', message: 'hi', options: {}, ...extra };
		await assert.rejects(new CorbitSms().execute.call(ctx(params)), (e) => /may have been sent/.test(e.description ?? ''));
	});
}

test('reading the balance: a lost connection does not mention a sent SMS', async () => {
	const params = { resource: 'account', operation: 'getBalance' };
	await assert.rejects(new CorbitSms().execute.call(ctx(params)), (e) => !/may have been sent/.test(e.description ?? ''));
});
