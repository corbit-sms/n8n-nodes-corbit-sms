// A lost connection during a send must not look safe to repeat: in the live test of 2026-11-20
// the connection dropped (ECONNRESET) after Corbit SMS had accepted and charged the SMS.
// Real n8n wraps a lost connection in a NodeApiError (whose text says "retry") before the node sees
// it, so the tests throw it the same way, and also as a plain error.
// Run `npm run build` first, then `npm test`.
const test = require('node:test');
const assert = require('node:assert/strict');
const { NodeApiError } = require('n8n-workflow');
const { CorbitSms } = require('../dist/nodes/CorbitSms/CorbitSms.node.js');

const NODE = { name: 'Corbit SMS', type: 'n8n-nodes-corbit-sms.corbitSms', typeVersion: 1, parameters: {} };

function reset() {
	return Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
}

const THROWS = {
	'wrapped by n8n': () => new NodeApiError(NODE, reset()),
	plain: () => reset(),
};

function ctx(params, makeError) {
	return {
		getInputData: () => [{ json: {} }],
		getNodeParameter: (name, _i, fallback) => (name in params ? params[name] : fallback),
		getNode: () => NODE,
		continueOnFail: () => false,
		getCredentials: async () => ({ apiToken: 'test-token', baseUrl: 'https://api.corbit.sa' }),
		helpers: {
			httpRequestWithAuthentication: async () => {
				throw makeError();
			},
		},
	};
}

for (const [how, makeError] of Object.entries(THROWS)) {
	for (const [operation, extra] of [
		['send', { to: '0501234567' }],
		['sendBulk', { numbers: '0501234567, 0509876543' }],
	]) {
		test(`${operation} (${how}): a lost connection says the SMS may have been sent, never "retry"`, async () => {
			const params = { resource: 'sms', operation, senderName: 'OT.SA', message: 'hi', options: {}, ...extra };
			await assert.rejects(new CorbitSms().execute.call(ctx(params, makeError)), (e) => {
				assert.match(e.message, /may have been sent/);
				assert.match(e.description ?? '', /may have been sent.*ECONNRESET/);
				assert.doesNotMatch(`${e.message} ${e.description}`, /retry the request/i);
				assert.doesNotMatch(`${e.message} ${e.description}`, /test-token/);
				return true;
			});
		});
	}

	test(`reading the balance (${how}): a lost connection does not mention a sent SMS`, async () => {
		const params = { resource: 'account', operation: 'getBalance' };
		await assert.rejects(new CorbitSms().execute.call(ctx(params, makeError)), (e) => !/may have been sent/.test(`${e.message} ${e.description ?? ''}`));
	});
}
