import { lookup, type LookupAddress, type LookupOptions } from "node:dns";
import { BlockList, isIP } from "node:net";

// Addresses a tenant URL must never reach: this host, the VPC, cloud metadata (169.254.169.254).
// BlockList also matches IPv4-mapped IPv6 (::ffff:127.0.0.1) against the IPv4 rules.
const blocked = new BlockList();
for (const [net, bits] of [
  ["0.0.0.0", 8], ["10.0.0.0", 8], ["100.64.0.0", 10], ["127.0.0.0", 8], ["169.254.0.0", 16], ["172.16.0.0", 12],
  ["192.0.0.0", 24], ["192.168.0.0", 16], ["198.18.0.0", 15], ["224.0.0.0", 4], ["240.0.0.0", 4],
] as const) blocked.addSubnet(net, bits, "ipv4");
for (const [net, bits] of [["::", 128], ["::1", 128], ["fc00::", 7], ["fe80::", 10], ["ff00::", 8], ["64:ff9b::", 96]] as const)
  blocked.addSubnet(net, bits, "ipv6");

export const isBlockedIp = (ip: string) => blocked.check(ip, isIP(ip) === 6 ? "ipv6" : "ipv4");

/** OUTBOUND_ALLOW=host,host:port skips the IP check for those (internal sinks in compose, localhost in tests). */
export function isAllowed(host: string, port: string) {
  const allow = (process.env.OUTBOUND_ALLOW ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean);
  // ponytail: the public demo's own sink lives on this process; it's the only private target a demo tenant gets.
  if (process.env.DEMO === "1") allow.push(`127.0.0.1:${process.env.PORT ?? 3200}`);
  host = host.toLowerCase().replace(/^\[|\]$/g, "");
  return allow.includes(host) || allow.includes(`${host}:${port}`);
}

export class BlockedUrl extends Error {
  code = "EBLOCKED";
}

/**
 * dns.lookup for http.request: refuses if ANY resolved address is blocked. The connection uses the
 * address checked here, so a rebinding DNS server can't pass the check and then point elsewhere.
 */
export function guardedLookup(
  host: string, options: LookupOptions,
  cb: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) {
  lookup(host, { ...options, all: true }, (err, addrs) => {
    if (err) return cb(err, "");
    const bad = addrs.find((a) => isBlockedIp(a.address));
    if (bad) return cb(new BlockedUrl(`${host} resolves to blocked address ${bad.address}`), "");
    if (options.all) return cb(null, addrs);
    cb(null, addrs[0].address, addrs[0].family);
  });
}
