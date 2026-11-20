import type {
	IDataObject,
	IExecuteFunctions,
	IHttpRequestMethods,
	IHttpRequestOptions,
	ILoadOptionsFunctions,
	INode,
	JsonObject,
} from 'n8n-workflow';
import { NodeApiError, NodeOperationError } from 'n8n-workflow';

export const MAX_MESSAGE_LENGTH = 1600;
export const MAX_IDEMPOTENCY_KEY_LENGTH = 255;

type Context = IExecuteFunctions | ILoadOptionsFunctions;

export interface CorbitRequestExtras {
	qs?: IDataObject;
	headers?: IDataObject;
	itemIndex?: number;
	/** True for a request that sends SMS: a lost connection may come after Corbit SMS accepted it. */
	sends?: boolean;
}

const MAYBE_SENT =
	'The connection was lost after the request was sent, so the SMS may have been sent. Check its status or your Corbit SMS account before you run this again, so it is not sent twice.';

// Invisible marks that come with numbers copied on Android, iOS and Arabic pages: Arabic letter
// mark, zero-width characters, direction marks, embeddings and isolates, word joiner, BOM.
// Removing them never changes a number.
const PHONE_MARKS = /[\u061c\u200b-\u200f\u202a-\u202c\u2060-\u2064\u2066-\u2069\ufeff]/g;
// Direction overrides (U+202D, U+202E) reverse how the digits are shown, so the number on the
// screen is not the number that would be sent: such a number is refused, not cleaned.
const DIRECTION_OVERRIDES = /[\u202d\u202e]/;
// A number is at most 40 characters once the invisible marks are removed, and 200 with them.
const MAX_NUMBER_LENGTH = 40;
const MAX_RAW_NUMBER_LENGTH = 200;
// A bracket at the start of a number may only hold a country code: "(+966) 50 123 4567".
const LEADING_BRACKET = /^\(\s*(?:\+|00)?\d{1,4}\s*\)/;

/** Balanced brackets, never nested, and no ")" closing the number (only spaces or hyphens after it). */
function bracketsOk(text: string): boolean {
	let open = false;
	for (const c of text) {
		if (c === '(') {
			if (open) return false;
			open = true;
		} else if (c === ')') {
			if (!open) return false;
			open = false;
		}
	}
	return !open && !/\)[\s-]*$/.test(text);
}

/**
 * Turns a phone number into the digits-only international format the API expects.
 * Accepts "+966 50 123 4567", "(+966) 50 123 4567", "00966501234567", "966501234567",
 * "+966 (0)50 123 4567", Arabic-Indic digits, and the Saudi local forms "0501234567" and "501234567".
 * Anything that could turn into a wrong number is rejected instead of guessed:
 * local numbers of other countries, decimals, "9.66501E+11" from a spreadsheet, "ext 12",
 * a bracket note at the end ("+971501234567 (1)").
 * Returns undefined when the number cannot be used.
 */
export function normalizeNumber(raw: unknown): string | undefined {
	let text: string;
	if (typeof raw === 'number') {
		if (!Number.isSafeInteger(raw) || raw <= 0) return undefined;
		text = String(raw);
	} else if (typeof raw === 'string') {
		if (raw.length > MAX_RAW_NUMBER_LENGTH || DIRECTION_OVERRIDES.test(raw)) return undefined;
		text = raw
			.replace(PHONE_MARKS, '')
			.trim()
			.replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x0660))
			.replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x06f0));
	} else {
		return undefined;
	}
	if (text.length > MAX_NUMBER_LENGTH) return undefined;
	// Only digits, spaces, "-", brackets and one leading "+" (an opening bracket may come before it).
	// Checked on the text as written, before anything is removed: a dot is never a separator.
	const body = text.replace(/^\(\s*/, '');
	if (!/^\+?[\d\s\-()]+$/.test(body)) return undefined;
	// "(+971501234567) 1" would become 9715012345671, someone else's number.
	if (text.startsWith('(') && !LEADING_BRACKET.test(text)) return undefined;
	// A ")" closing the number is a note or an extension ("+971501234567 (1)", "(1-01)", "(1) -"), and brackets
	// must pair up without nesting ("(1", "1)", "((1))"): dropping them would give 9715012345671, someone else.
	// Balanced brackets at the start or in the middle are formatting: "(+966) 50 ...", "+1 (202) 555-0123".
	if (!bracketsOk(text)) return undefined;
	let digits = text.replace(/\D/g, '');
	if (body.startsWith('+')) {
		// Already international.
	} else if (digits.startsWith('00')) {
		digits = digits.slice(2);
	} else if (/^05\d{8}$/.test(digits)) {
		digits = '966' + digits.slice(1);
	} else if (/^5\d{8}$/.test(digits)) {
		digits = '966' + digits;
	} else if (digits.startsWith('0')) {
		return undefined;
	}
	// "+966 (0)50 …": drop the trunk zero after the Saudi country code.
	if (/^9660\d{9}$/.test(digits)) digits = '966' + digits.slice(4);
	// A Saudi mobile number is exactly 9665 + 8 digits; anything else would reach a wrong number.
	if (digits.startsWith('9665') && !/^9665\d{8}$/.test(digits)) return undefined;
	return /^[1-9]\d{7,14}$/.test(digits) ? digits : undefined;
}

// What separates one number from the next in a pasted list: comma, semicolon,
// new line, tab, and the Arabic comma and semicolon (what the Arabic iPhone
// keyboard types). A space alone is not a separator: see splitNumbers.
const LIST_SEPARATORS = /[,;،؛\r\n\t]+/;
// A piece that reads as one number written with spaces (as copied from phone contacts). It is tested
// after an opening bracket at the start is removed, so "(+966) 50 123 4567" stays one number.
const SPACED_NUMBER = /^\+?[0-9٠-٩۰-۹()\-\s]+$/;

/**
 * Splits a list given as text or as an array, the same way the Corbit SMS app does.
 * "+966 50 123 4567" stays one number; "0501234567 0509876543" becomes two, because a
 * piece is split on its spaces only when it is not a number once the spaces are removed.
 */
export function splitNumbers(value: unknown): string[] {
	if (Array.isArray(value)) return value.flatMap((v) => splitNumbers(v));
	if (value === null || value === undefined) return [];
	const tokens: string[] = [];
	for (const piece of String(value).split(LIST_SEPARATORS)) {
		const p = piece.replace(PHONE_MARKS, '').trim();
		if (p === '') continue;
		if (SPACED_NUMBER.test(p.replace(/^\(\s*/, ''))) {
			const joined = p.replace(/\s+/g, '');
			if (normalizeNumber(joined)) {
				tokens.push(joined);
				continue;
			}
		}
		tokens.push(...p.split(/\s+/).filter((t) => t !== ''));
	}
	return tokens;
}

/**
 * Checks the SMS text and returns it as a string. Expressions can return numbers
 * (for example an OTP code), so the value is converted first.
 */
export function checkMessage(node: INode, raw: unknown, itemIndex: number): string {
	const message = raw === null || raw === undefined ? '' : String(raw);
	if (message.trim() === '') {
		throw new NodeOperationError(node, "'Message' is empty", {
			itemIndex,
			description: 'Enter the text of the SMS.',
		});
	}
	if (message.length > MAX_MESSAGE_LENGTH) {
		throw new NodeOperationError(
			node,
			`'Message' is ${message.length} characters; the limit is ${MAX_MESSAGE_LENGTH}`,
			{ itemIndex },
		);
	}
	return message;
}

const CODE_HINTS: Record<string, string> = {
	INSUFFICIENT_BALANCE: 'Your Corbit SMS balance is not enough. Top up at sms.corbit.sa and run the node again.',
	SENDER_NOT_ALLOWED:
		"This sender name is not approved on your account. Pick one from the 'Sender Name' list.",
	DUPLICATE:
		"The same text was sent to the same number within the last hour. Turn on 'Allow Duplicate' to send it again on purpose.",
	IDEMPOTENCY_IN_PROGRESS:
		'A request with the same idempotency key is still being processed. Wait a moment and try again.',
	IDEMPOTENCY_KEY_REUSED:
		"This idempotency key was already used for a different message. Use a different 'Idempotency Key' for each message, for example with an expression.",
};

function errorFromBody(
	node: INode,
	statusCode: number,
	body: IDataObject,
	headers: IDataObject,
	itemIndex?: number,
): NodeApiError {
	const apiMessage = typeof body.message === 'string' && body.message ? body.message : '';
	const code = typeof body.code === 'string' ? body.code : '';
	let description = code ? CODE_HINTS[code] ?? `Corbit SMS code: ${code}` : undefined;
	if (statusCode === 401) {
		description = "The API token was rejected. Check 'API Token' in the Corbit SMS credential.";
	} else if (statusCode === 429 || code === 'RATE_LIMIT') {
		const retryAfter = headers['retry-after'];
		description = `Too many requests. ${
			retryAfter ? `Try again in ${String(retryAfter)} seconds. ` : ''
		}You can turn on 'Retry On Fail' in the node settings.`;
	}
	return new NodeApiError(node, body as JsonObject, {
		message: apiMessage || `Corbit SMS returned HTTP ${statusCode}`,
		description,
		...(statusCode >= 400 ? { httpCode: String(statusCode) } : {}),
		itemIndex,
	});
}

/** The system error code of a lost connection (e.g. ECONNRESET), looked up through wrapped errors. Never the message text. */
function networkErrorCode(error: unknown): string | undefined {
	let current: unknown = error;
	for (let depth = 0; depth < 4 && current !== null && typeof current === 'object'; depth++) {
		const code = (current as { code?: unknown }).code;
		if (typeof code === 'string' && /^E[A-Z_]{2,30}$/.test(code)) return code;
		current = (current as { cause?: unknown }).cause;
	}
	return undefined;
}

/**
 * Calls the Corbit SMS API with the stored credential.
 * Throws a NodeApiError with the API's own message when the call fails.
 */
export async function corbitApiRequest(
	this: Context,
	method: IHttpRequestMethods,
	path: string,
	body?: IDataObject,
	extras: CorbitRequestExtras = {},
): Promise<IDataObject> {
	const credentials = await this.getCredentials('corbitSmsApi');
	const baseUrl = String(credentials.baseUrl || 'https://api.corbit.sa').replace(/\/+$/, '');

	const options: IHttpRequestOptions = {
		method,
		url: `${baseUrl}${path}`,
		headers: { Accept: 'application/json', ...(extras.headers ?? {}) },
		json: true,
		returnFullResponse: true,
		ignoreHttpStatusErrors: true,
	};
	if (body !== undefined) options.body = body;
	if (extras.qs !== undefined) options.qs = extras.qs;

	let response: { statusCode: number; body: unknown; headers?: IDataObject };
	try {
		response = (await this.helpers.httpRequestWithAuthentication.call(
			this,
			'corbitSmsApi',
			options,
		)) as typeof response;
	} catch (error) {
		if (extras.sends) {
			// n8n already wraps a lost connection in a NodeApiError whose text says "retry", and wrapping it
			// again keeps that text and drops our options. A new error is the only way to warn that the SMS
			// may have been sent (live test 2026-11-20: ECONNRESET after Corbit SMS had accepted it).
			// The error code goes in the description only: n8n replaces a message that contains a code such as
			// ECONNRESET with its own "retry" text.
			const code = networkErrorCode(error);
			throw new NodeOperationError(this.getNode(), 'Could not reach Corbit SMS; the SMS may have been sent', {
				itemIndex: extras.itemIndex,
				description: code ? `${MAYBE_SENT} (Error code: ${code})` : MAYBE_SENT,
			});
		}
		throw new NodeApiError(this.getNode(), error as JsonObject, { itemIndex: extras.itemIndex });
	}

	const statusCode = Number(response.statusCode);
	let data = response.body;
	if (typeof data === 'string') {
		try {
			data = JSON.parse(data);
		} catch {
			data = { message: data };
		}
	}
	const parsed: IDataObject =
		data && typeof data === 'object' && !Array.isArray(data) ? (data as IDataObject) : {};

	if (statusCode >= 400 || parsed.status === 'Error') {
		throw errorFromBody(this.getNode(), statusCode, parsed, response.headers ?? {}, extras.itemIndex);
	}
	if (Array.isArray(data)) return { data } as IDataObject;
	return parsed;
}

/**
 * Reads the sender names page by page. Stops after `maxItems` names when given,
 * when the last page is reached, or when the API keeps returning the same page.
 */
export async function getAllSenderNames(this: Context, maxItems?: number): Promise<IDataObject[]> {
	const perPage = 50;
	const all: IDataObject[] = [];
	let previousFirst: string | undefined;
	for (let page = 1; page <= 100; page++) {
		const response = await corbitApiRequest.call(this, 'GET', '/api/v1/sendernames', undefined, {
			qs: { per_page: perPage, page },
		});
		const items = Array.isArray(response.data) ? (response.data as IDataObject[]) : [];
		if (items.length === 0) break;
		const first = JSON.stringify(items[0]);
		if (page > 1 && first === previousFirst) break;
		previousFirst = first;
		all.push(...items);
		if (maxItems !== undefined && all.length >= maxItems) break;
		const pagination = (response.pagination ?? {}) as IDataObject;
		const total = Number(pagination.total);
		const currentPage = Number(pagination.current_page);
		const pageSize = Number(pagination.per_page) || perPage;
		if (Number.isFinite(total) && all.length >= total) break;
		if (!Number.isFinite(total) && items.length < pageSize) break;
		// Stop if the API ignores the page parameter, so we never loop on the same page.
		if (Number.isFinite(currentPage) && currentPage !== page) break;
	}
	return maxItems === undefined ? all : all.slice(0, maxItems);
}
