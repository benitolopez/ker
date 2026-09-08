import { type Static, Type } from "@sinclair/typebox";
import { MessageDeltaEvent, ReasoningDeltaEvent } from "./index.ts";

export const NODE_PROTOCOL_VERSION = "1" as const;

export const StoredRecord = Type.Object(
	{
		version: Type.Integer(),
		recordId: Type.String(),
		previousRecordId: Type.Union([Type.String(), Type.Null()]),
		at: Type.String(),
		type: Type.String(),
	},
	{ additionalProperties: true },
);
export type StoredRecord = Static<typeof StoredRecord>;

export const NodeIdentity = Type.Object(
	{ id: Type.String(), name: Type.String(), createdAt: Type.String() },
	{ additionalProperties: false },
);

const enroll = Type.Object(
	{ type: Type.Literal("enroll"), token: Type.String(), identity: NodeIdentity },
	{ additionalProperties: false },
);
const auth = Type.Object(
	{ type: Type.Literal("auth"), nodeId: Type.String(), secret: Type.String() },
	{ additionalProperties: false },
);
const hello = Type.Object(
	{
		type: Type.Literal("hello"),
		nodeProtocol: Type.String(),
		storeVersion: Type.Integer(),
		running: Type.Array(Type.String()),
	},
	{ additionalProperties: false },
);
const records = Type.Object(
	{ type: Type.Literal("records"), sessionId: Type.String(), records: Type.Array(StoredRecord) },
	{ additionalProperties: false },
);
const drained = Type.Object({ type: Type.Literal("drained") }, { additionalProperties: false });
const delta = Type.Object(
	{
		type: Type.Literal("delta"),
		sessionId: Type.String(),
		event: Type.Union([MessageDeltaEvent, ReasoningDeltaEvent]),
	},
	{ additionalProperties: false },
);
const load = Type.Object(
	{ type: Type.Literal("load"), id: Type.String(), sessionId: Type.String() },
	{ additionalProperties: false },
);
const result = Type.Object(
	{ type: Type.Literal("result"), id: Type.String(), value: Type.Unknown() },
	{ additionalProperties: false },
);
const error = Type.Object(
	{
		type: Type.Literal("error"),
		id: Type.String(),
		code: Type.Union([
			Type.Literal("invalid_cwd"),
			Type.Literal("unknown_session"),
			Type.Literal("turn_unavailable"),
			Type.Literal("context_exhausted"),
			Type.Literal("internal"),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
);

export const NodeToPlaneFrame = Type.Union([enroll, auth, hello, records, drained, delta, load, result, error]);
export type NodeToPlaneFrame = Static<typeof NodeToPlaneFrame>;

const welcome = Type.Object(
	{ type: Type.Literal("welcome"), nodeId: Type.String(), secret: Type.Optional(Type.String()) },
	{ additionalProperties: false },
);
const refused = Type.Object(
	{
		type: Type.Literal("refused"),
		code: Type.Union([
			Type.Literal("unauthorized"),
			Type.Literal("revoked"),
			Type.Literal("token_expired"),
			Type.Literal("token_used"),
			Type.Literal("version_mismatch"),
		]),
		message: Type.String(),
	},
	{ additionalProperties: false },
);
const ready = Type.Object(
	{ type: Type.Literal("ready"), recover: Type.Array(Type.String()) },
	{ additionalProperties: false },
);
const ack = Type.Object(
	{ type: Type.Literal("ack"), sessionId: Type.String(), recordId: Type.String() },
	{ additionalProperties: false },
);
const reject = Type.Object(
	{
		type: Type.Literal("reject"),
		sessionId: Type.String(),
		recordId: Type.String(),
		reason: Type.Literal("chain"),
	},
	{ additionalProperties: false },
);
export const NodeCallMethod = Type.Union([
	Type.Literal("createSession"),
	Type.Literal("admit"),
	Type.Literal("compact"),
	Type.Literal("cancel"),
	Type.Literal("recover"),
	Type.Literal("resolveProjectRoot"),
	Type.Literal("observeGitRemote"),
	Type.Literal("folderExists"),
]);
export type NodeCallMethod = Static<typeof NodeCallMethod>;
const call = Type.Object(
	{ type: Type.Literal("call"), id: Type.String(), method: NodeCallMethod, args: Type.Array(Type.Unknown()) },
	{ additionalProperties: false },
);
const chunk = Type.Object(
	{ type: Type.Literal("chunk"), id: Type.String(), text: Type.String() },
	{ additionalProperties: false },
);
const end = Type.Object(
	{ type: Type.Literal("end"), id: Type.String(), found: Type.Boolean() },
	{ additionalProperties: false },
);
const hb = Type.Object({ type: Type.Literal("hb") }, { additionalProperties: false });

export const PlaneToNodeFrame = Type.Union([welcome, refused, ready, ack, reject, call, chunk, end, hb]);
export type PlaneToNodeFrame = Static<typeof PlaneToNodeFrame>;
