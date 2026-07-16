import protobuf from 'protobufjs';

// Reverse-engineered schema for Nanit's camera control WebSocket
// (wss://api.nanit.com/focus/cameras/{camera_uid}/user_connect). Only the *messages* this plugin
// actually sends or receives are kept (settings, playback, firmware, wifi setup, etc bodies are
// intentionally omitted, since this plugin never issues those requests). RequestType is a deliberate
// exception - it's kept in full even though we only ever build/handle a few of these: the camera pushes
// RESPONSE messages for plenty of other request types (status, keepalive, etc) as part of its own
// routine chatter, and protobufjs fails to decode a required enum field at all when the wire value
// doesn't match any declared enum entry - trimming this enum down doesn't shrink what we handle, it
// just makes otherwise-harmless messages fail to parse. Field numbers and enum values throughout this
// file have been verified for accuracy rather than left as untested guesses.
const PROTO_SOURCE = `
syntax = "proto2";
package client;

enum RequestType {
  GET_STREAMING = 3;
  PUT_STREAMING = 2;
  GET_SETTINGS = 4;
  PUT_SETTINGS = 5;
  GET_CONTROL = 6;
  PUT_CONTROL = 7;
  GET_STATUS = 8;
  PUT_STATUS = 9;
  GET_SENSOR_DATA = 12;
  PUT_SENSOR_DATA = 11;
  GET_UCTOKENS = 13;
  PUT_UCTOKENS = 14;
  PUT_SETUP_NETWORK = 15;
  PUT_SETUP_SERVER = 16;
  GET_FIRMWARE = 17;
  PUT_FIRMWARE = 18;
  GET_PLAYBACK = 19;
  PUT_PLAYBACK = 20;
  GET_SOUNDTRACKS = 21;
  GET_STATUS_NETWORK = 22;
  GET_LIST_NETWORKS = 23;
  GET_LOGS = 24;
  GET_BANDWIDTH = 25;
  GET_AUDIO_STREAMING = 26;
  PUT_AUDIO_STREAMING = 27;
  GET_WIFI_SETUP = 28;
  PUT_WIFI_SETUP = 29;
  PUT_STING_START = 30;
  PUT_STING_STOP = 31;
  PUT_STING_STATUS = 32;
  PUT_STING_ALERT = 34;
  PUT_KEEP_ALIVE = 35;
  GET_STING_STATUS = 36;
  PUT_STING_TEST = 37;
  PUT_RTSP_STREAMING = 38;
  GET_UOM_URI = 39;
  GET_UOM = 40;
  PUT_UOM = 41;
  GET_AUTH_KEY = 42;
  PUT_AUTH_KEY = 43;
  PUT_HEALTH = 44;
  PUT_TCP_REQUEST = 45;
  GET_STING_START = 46;
  GET_LOGS_URI = 47;
  PUT_SETUP_NETWORK_AP = 48;
  PUT_REBOOT = 49;
  PUT_WEBRTC_SERVICE_MESSAGE = 50;
  GET_SAFE_ZONE_ROI = 51;
  PUT_SAFE_ZONE_ROI = 52;
}

enum SensorType {
  SOUND = 0;
  MOTION = 1;
  TEMPERATURE = 2;
  HUMIDITY = 3;
  LIGHT = 4;
  NIGHT = 5;
  SAFETY = 6;
  CRY = 7;

  // Undocumented - observed arriving as a second entry alongside a CRY push in the same message
  // (sharing that entry's timestamp/timestampReal, always isAlert=false). Meaning unconfirmed;
  // named generically rather than guessed so decoding doesn't fail on it like CRY once did.
  UNKNOWN_8 = 8;
}

message SensorData {
  required SensorType sensorType = 1;
  optional bool isAlert = 4;
  optional int32 timestamp = 5;
  optional int32 valueMilli = 6;
  optional int32 value = 3;

  // Higher-precision companion to timestamp above (observed as timestamp*1000 plus a sub-second
  // remainder). Decoded but not currently used for anything - the 10s auto-reset window in
  // triggerAudioDetected()/triggerMotion() doesn't need sub-second precision.
  optional int64 timestampReal = 7;
}

message GetSensorData {
  optional bool all = 1;
  optional bool temperature = 4;
  optional bool humidity = 5;
  optional bool light = 6;
  optional bool night = 7;
}

// GET_SENSOR_DATA{all: true} above only returns a one-time snapshot. Sending this as well is what
// actually turns on continuous push delivery for each sensor type (TEMPERATURE/HUMIDITY appear to
// be pushed regardless, but SOUND/MOTION/CRY may not be without this).
message SensorDataTransfer {
  optional bool sound = 1;
  optional bool motion = 2;
  optional bool temperature = 3;
  optional bool humidity = 4;
  optional bool light = 5;
  optional bool night = 6;
  optional bool safeZone = 7;
  optional bool cry = 8;
}

message Control {
  optional SensorDataTransfer sensorDataTransferEn = 4;
}

enum StreamIdentifier {
  DVR = 0;
  ANALYTICS = 1;
  MOBILE = 2;
}

message Streaming {
  required StreamIdentifier id = 1;

  enum Status {
    STARTED = 0;
    STOPPED = 1;
    PAUSED = 2;
  }

  required Status status = 2;
  required string rtmpUrl = 3;
  optional int32 attempts = 4;
}

// Two-way audio, the reverse direction of Streaming above: instead of the camera publishing to
// a URL we give it, we publish audio and this tells the camera where to connect and play it.
// PAUSED is included defensively even though only STARTED/STOPPED are confirmed for this specific
// message (unlike Streaming.Status above) - status is a required field, so an unrecognized value
// here would otherwise fail the whole message to decode, the same class of bug CRY once hit.
message AudioStreaming {
  enum Status {
    STARTED = 0;
    STOPPED = 1;
    PAUSED = 2;
  }

  required Status status = 1;
  optional string rtmpUrl = 2;
  optional string sessionId = 3;
}

// WebRTC signaling envelope (SDP offers/answers, ICE candidates, and the stream-stopped notice
// below) used for a separate, newer streaming path this plugin doesn't use. Only the
// streamStopped case is modeled here - the other cases (remoteDescription, localOffer,
// localDescription, stopStream, iceCandidate) are left undeclared and simply skipped on decode,
// same as any other field this plugin doesn't need.
enum WebRtcStreamStoppedState {
  ON_REQUEST = 1;
  DISCONNECTED = 2;
  FAILED = 3;
  ERROR = 4;
}

message WebRtcStreamStopped {
  optional WebRtcStreamStoppedState state = 2;
  optional string statusMessage = 3;
}

message WebRtc {
  optional WebRtcStreamStopped streamStopped = 5;
}

message Request {
  required int32 id = 1;
  required RequestType type = 2;

  optional GetSensorData getSensorData = 12;
  repeated SensorData sensorData = 13;

  optional Streaming streaming = 4;
  optional Control control = 15;
  optional AudioStreaming audioStreaming = 20;
  optional WebRtc webrtc = 36;
}

message Response {
  required int32 requestId = 1;
  required RequestType requestType = 2;
  required int32 statusCode = 3;
  optional string statusMessage = 4;

  repeated SensorData sensorData = 9;
  optional AudioStreaming audioStreaming = 20;
}

message Message {
  enum Type {
    KEEPALIVE = 0;
    REQUEST = 1;
    RESPONSE = 2;
  }
  required Type type = 1;
  optional Request request = 2;
  optional Response response = 3;
}
`;

const root = protobuf.parse(PROTO_SOURCE, new protobuf.Root(), { keepCase: true }).root;
const MessageType = root.lookupType('client.Message');

const decodeOpts: protobuf.IConversionOptions = { enums: String, longs: Number, defaults: true, arrays: true };

export interface DecodedSensorData {
    sensorType: 'SOUND' | 'MOTION' | 'TEMPERATURE' | 'HUMIDITY' | 'LIGHT' | 'NIGHT' | 'SAFETY' | 'CRY' | 'UNKNOWN_8';
    isAlert?: boolean;
    timestamp?: number;
    valueMilli?: number;
    value?: number;
    timestampReal?: number;
}

export interface DecodedWebRtcStreamStopped {
    state?: 'ON_REQUEST' | 'DISCONNECTED' | 'FAILED' | 'ERROR';
    statusMessage?: string;
}

export interface DecodedAudioStreaming {
    status: 'STARTED' | 'STOPPED' | 'PAUSED';
    rtmpUrl?: string;
    sessionId?: string;
}

export interface DecodedMessage {
    type: 'KEEPALIVE' | 'REQUEST' | 'RESPONSE';
    request?: {
        id: number;
        type: string;
        sensorData?: DecodedSensorData[];
        audioStreaming?: DecodedAudioStreaming;
        webrtc?: {
            streamStopped?: DecodedWebRtcStreamStopped;
        };
    };
    response?: {
        requestId: number;
        requestType: string;
        statusCode: number;
        statusMessage?: string;
    };
}

export function encodeControlMessage(payload: Record<string, unknown>): Buffer {
    const message = MessageType.fromObject(payload);
    return Buffer.from(MessageType.encode(message).finish());
}

export function decodeControlMessage(data: Uint8Array): DecodedMessage {
    const message = MessageType.decode(data);
    return MessageType.toObject(message, decodeOpts) as DecodedMessage;
}
