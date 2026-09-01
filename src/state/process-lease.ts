import { randomUUID } from "node:crypto";
import { createConnection, createServer, type Server } from "node:net";
import { z } from "zod";

const LOOPBACK_ADDRESS = "127.0.0.1";
const LEASE_PROBE_TIMEOUT_MS = 1_000;
const TcpAddressSchema = z.object({ port: z.number().int().min(1).max(65_535) });

export const ProcessLeaseSchema = z.object({
  schemaVersion: z.literal(1),
  port: z.number().int().min(1).max(65_535),
  token: z.string().uuid(),
});
export type ProcessLease = z.infer<typeof ProcessLeaseSchema>;

export interface OwnedProcessLease {
  readonly identity: ProcessLease;
  close(): void;
}

export async function startProcessLease(): Promise<OwnedProcessLease> {
  const token = randomUUID();
  const server = createServer((socket) => {
    socket.on("error", () => {});
    socket.end(token);
    socket.unref();
  });
  server.on("error", () => {
    // A failed listener makes the next lease probe stale without aborting the active review.
  });

  const port = await listenOnLoopback(server);
  const identity = ProcessLeaseSchema.parse({ schemaVersion: 1, port, token });
  if (!(await isProcessLeaseAlive(identity))) {
    server.close();
    throw new Error("Could not verify the DiffOwl process lease.");
  }
  server.unref();

  let closed = false;
  return {
    identity,
    close() {
      if (closed) return;
      closed = true;
      server.close();
    },
  };
}

export function isProcessLeaseAlive(lease: ProcessLease): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host: LOOPBACK_ADDRESS, port: lease.port });
    socket.setEncoding("utf8");
    let response = "";
    let settled = false;
    const settle = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(alive);
    };

    socket.setTimeout(LEASE_PROBE_TIMEOUT_MS, () => settle(false));
    socket.on("data", (chunk) => {
      response += chunk;
      if (response.length > lease.token.length) settle(false);
    });
    socket.on("end", () => settle(response === lease.token));
    socket.on("error", () => settle(false));
  });
}

function listenOnLoopback(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    const rejectListen = (error: Error): void => reject(error);
    server.once("error", rejectListen);
    server.listen({ host: LOOPBACK_ADDRESS, port: 0, exclusive: true }, () => {
      server.off("error", rejectListen);
      const address = TcpAddressSchema.safeParse(server.address());
      if (!address.success) {
        server.close();
        reject(new Error("DiffOwl process lease did not bind a TCP port."));
        return;
      }
      resolve(address.data.port);
    });
  });
}
