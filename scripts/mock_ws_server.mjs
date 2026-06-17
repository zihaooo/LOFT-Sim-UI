#!/usr/bin/env node
import { createServer } from "node:http";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const HEADER_BYTES = 16;
const RECORD_BYTES = 52;
const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const VALID_HZ = new Set([30, 60, 120]);

const args = parseArgs(process.argv.slice(2));
const dataPath = resolve(args.data ?? "mock/mock_telemetry.json");
const telemetryHz = Number(args.hz ?? 60);
const port = Number(args.port ?? 8765);

if (!VALID_HZ.has(telemetryHz)) {
  throw new Error(`--hz must be one of 30, 60, 120. Received ${telemetryHz}.`);
}

const mockData = JSON.parse(readFileSync(dataPath, "utf8"));
const corridorsByHandle = new Map(mockData.corridors.map((corridor) => [corridor.handle, corridor]));
let sequence = 0;
let simTimeSeconds = 0;
let streaming = true;
const clients = new Set();

const server = createServer((_, response) => {
  response.writeHead(404);
  response.end("WebSocket endpoint is /ws\n");
});

server.on("upgrade", (request, socket) => {
  if (new URL(request.url ?? "/", "http://localhost").pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const key = request.headers["sec-websocket-key"];
  if (typeof key !== "string") {
    socket.destroy();
    return;
  }

  const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
  socket.write([
    "HTTP/1.1 101 Switching Protocols",
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Accept: ${accept}`,
    "",
    "",
  ].join("\r\n"));

  clients.add(socket);
  socket.on("close", () => clients.delete(socket));
  socket.on("error", () => clients.delete(socket));
  socket.on("data", (chunk) => {
    readClientFrames(socket, chunk);
  });
  socket.write(encodeWebSocketFrame(Buffer.from(JSON.stringify(createRegistryMessage()), "utf8"), 0x1));
});

setInterval(() => {
  if (!streaming) {
    return;
  }

  simTimeSeconds += 1 / telemetryHz;
  sequence += 1;
  const payload = createSnapshotPayload(sequence, simTimeSeconds);
  const frame = encodeWebSocketFrame(payload, 0x2);

  for (const client of clients) {
    if (client.destroyed || client.writableNeedDrain) {
      continue;
    }
    client.write(frame);
  }
}, 1000 / telemetryHz);

server.listen(port, "127.0.0.1", () => {
  console.log(`mock telemetry websocket listening at ws://127.0.0.1:${port}/ws`);
  console.log(`data=${dataPath} drones=${mockData.drones.length} hz=${telemetryHz}`);
});

function parseArgs(argv) {
  const parsed = {};
  for (let index = 0; index < argv.length; index += 1) {
    const item = argv[index];
    if (!item.startsWith("--")) {
      continue;
    }
    parsed[item.slice(2)] = argv[index + 1];
    index += 1;
  }
  return parsed;
}

function createRegistryMessage() {
  return {
    type: "registry",
    projection: mockData.projection,
    corridors: mockData.corridors.map((corridor) => ({ handle: corridor.handle, id: corridor.id })),
    drones: mockData.drones.map((drone) => ({
      handle: drone.handle,
      id: drone.id,
      vehicleType: drone.vehicle_type,
    })),
  };
}

function applyControlMessage(rawMessage) {
  let message;
  try {
    message = JSON.parse(rawMessage);
  } catch {
    return;
  }

  if (message.type === "pause") {
    streaming = false;
    return;
  }

  if (message.type === "resume") {
    streaming = true;
  }
}

function readClientFrames(socket, chunk) {
  socket._mockWsBuffer = socket._mockWsBuffer ? Buffer.concat([socket._mockWsBuffer, chunk]) : chunk;

  while (socket._mockWsBuffer.length >= 2) {
    const firstByte = socket._mockWsBuffer[0];
    const secondByte = socket._mockWsBuffer[1];
    const opcode = firstByte & 0x0f;
    const masked = (secondByte & 0x80) !== 0;
    let payloadLength = secondByte & 0x7f;
    let offset = 2;

    if (payloadLength === 126) {
      if (socket._mockWsBuffer.length < offset + 2) {
        return;
      }
      payloadLength = socket._mockWsBuffer.readUInt16BE(offset);
      offset += 2;
    } else if (payloadLength === 127) {
      if (socket._mockWsBuffer.length < offset + 8) {
        return;
      }
      const longPayloadLength = socket._mockWsBuffer.readBigUInt64BE(offset);
      if (longPayloadLength > BigInt(Number.MAX_SAFE_INTEGER)) {
        socket.destroy();
        return;
      }
      payloadLength = Number(longPayloadLength);
      offset += 8;
    }

    const maskBytes = masked ? 4 : 0;
    const frameLength = offset + maskBytes + payloadLength;
    if (socket._mockWsBuffer.length < frameLength) {
      return;
    }

    let payload = socket._mockWsBuffer.subarray(offset + maskBytes, frameLength);
    if (masked) {
      const mask = socket._mockWsBuffer.subarray(offset, offset + 4);
      payload = Buffer.from(payload.map((byte, index) => byte ^ mask[index % 4]));
    }

    socket._mockWsBuffer = socket._mockWsBuffer.subarray(frameLength);

    if (opcode === 0x8) {
      socket.end();
      return;
    }

    if (opcode === 0x1) {
      applyControlMessage(payload.toString("utf8"));
    }
  }
}

function createSnapshotPayload(snapshotSequence, snapshotTimeSeconds) {
  const buffer = Buffer.allocUnsafe(HEADER_BYTES + mockData.drones.length * RECORD_BYTES);
  buffer.writeUInt32LE(snapshotSequence, 0);
  buffer.writeDoubleLE(snapshotTimeSeconds, 4);
  buffer.writeUInt32LE(mockData.drones.length, 12);

  for (let index = 0; index < mockData.drones.length; index += 1) {
    const drone = mockData.drones[index];
    const corridor = corridorsByHandle.get(drone.corridor_handle);
    const sampled = sampleCorridor(corridor, drone, snapshotTimeSeconds);
    const offset = HEADER_BYTES + index * RECORD_BYTES;

    buffer.writeUInt32LE(drone.handle, offset);
    buffer.writeUInt16LE(1, offset + 4);
    buffer.writeUInt16LE(drone.vehicle_type_code, offset + 6);
    buffer.writeUInt32LE(drone.corridor_handle, offset + 8);
    buffer.writeFloatLE(sampled.x, offset + 12);
    buffer.writeFloatLE(sampled.y, offset + 16);
    buffer.writeFloatLE(sampled.z, offset + 20);
    buffer.writeFloatLE(sampled.vx, offset + 24);
    buffer.writeFloatLE(sampled.vy, offset + 28);
    buffer.writeFloatLE(sampled.vz, offset + 32);
    buffer.writeFloatLE(sampled.yaw, offset + 36);
    buffer.writeFloatLE(0, offset + 40);
    buffer.writeFloatLE(0, offset + 44);
    buffer.writeFloatLE(drone.speed_mps, offset + 48);
  }

  return buffer;
}

function sampleCorridor(corridor, drone, timeSeconds) {
  const corridorLength = Math.max(corridor.length_m, 1);
  const distance = (drone.offset_m + timeSeconds * drone.speed_mps) % corridorLength;
  const index = findSegmentIndex(corridor.cumulative_lengths, distance);
  const start = corridor.points[Math.max(0, index - 1)];
  const end = corridor.points[index] ?? start;
  const segmentStart = corridor.cumulative_lengths[Math.max(0, index - 1)] ?? 0;
  const segmentEnd = corridor.cumulative_lengths[index] ?? segmentStart;
  const segmentLength = Math.max(segmentEnd - segmentStart, 0.0001);
  const t = Math.min(Math.max((distance - segmentStart) / segmentLength, 0), 1);
  const dx = end.x - start.x;
  const dy = end.y - start.y;
  const dz = end.z - start.z;
  const length = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.0001);
  const noise = mockData.noise_m ? Math.sin(drone.noise_seed + timeSeconds) * mockData.noise_m : 0;

  return {
    x: start.x + dx * t + noise,
    y: start.y + dy * t + noise,
    z: start.z + dz * t,
    vx: (dx / length) * drone.speed_mps,
    vy: (dy / length) * drone.speed_mps,
    vz: (dz / length) * drone.speed_mps,
    yaw: Math.atan2(dx, dy),
  };
}

function findSegmentIndex(cumulativeLengths, distance) {
  for (let index = 1; index < cumulativeLengths.length; index += 1) {
    if (distance <= cumulativeLengths[index]) {
      return index;
    }
  }
  return cumulativeLengths.length - 1;
}

function encodeWebSocketFrame(payload, opcode) {
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.allocUnsafe(2);
    header[0] = 0x80 | opcode;
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.allocUnsafe(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.allocUnsafe(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }

  return Buffer.concat([header, payload]);
}
