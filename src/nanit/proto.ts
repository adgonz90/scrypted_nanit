import protobuf from 'protobufjs';

// Reverse-engineered schema for Nanit's camera control WebSocket
// (wss://api.nanit.com/focus/cameras/{camera_uid}/user_connect). Only the enums/messages this
// plugin actually sends or receives are kept; the rest of the camera's control protocol (settings,
// playback, firmware, wifi setup, etc.) is intentionally omitted since this plugin never issues
// those requests.
const PROTO_SOURCE = `
syntax = "proto2";
package client;

enum RequestType {
  PUT_STREAMING = 2;
  GET_SENSOR_DATA = 12;
  PUT_SENSOR_DATA = 11;
}

enum SensorType {
  SOUND = 0;
  MOTION = 1;
  TEMPERATURE = 2;
  HUMIDITY = 3;
  LIGHT = 4;
  NIGHT = 5;
}

message SensorData {
  required SensorType sensorType = 1;
  optional bool isAlert = 4;
  optional int32 timestamp = 5;
  optional int32 valueMilli = 6;
  optional int32 value = 3;
}

message GetSensorData {
  optional bool all = 1;
  optional bool temperature = 4;
  optional bool humidity = 5;
  optional bool light = 6;
  optional bool night = 7;
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

message Request {
  required int32 id = 1;
  required RequestType type = 2;

  optional GetSensorData getSensorData = 12;
  repeated SensorData sensorData = 13;

  optional Streaming streaming = 4;
}

message Response {
  required int32 requestId = 1;
  required RequestType requestType = 2;
  required int32 statusCode = 3;
  optional string statusMessage = 4;

  repeated SensorData sensorData = 9;
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
    sensorType: 'SOUND' | 'MOTION' | 'TEMPERATURE' | 'HUMIDITY' | 'LIGHT' | 'NIGHT';
    isAlert?: boolean;
    timestamp?: number;
    valueMilli?: number;
    value?: number;
}

export interface DecodedMessage {
    type: 'KEEPALIVE' | 'REQUEST' | 'RESPONSE';
    request?: {
        id: number;
        type: string;
        sensorData?: DecodedSensorData[];
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
