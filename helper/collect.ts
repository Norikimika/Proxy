const RAW_PROXY_LIST_FILE = "./ProxyRaw.txt";
const CANDIDATE_LIST_FILE = "./ProxyCandidate.txt";
const REQUEST_TIMEOUT = 30_000;

const SOURCES = [
  "https://raw.githubusercontent.com/0688001/proxyip/main/data/all.txt",
  "https://raw.githubusercontent.com/malvenk/ProxyIP-Pool/main/ips/all.txt",
];

const PROXY_PATTERN = /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})[:,](\d{1,5})/g;

function parseSource(text: string, into: Set<string>) {
  for (const match of text.matchAll(PROXY_PATTERN)) {
    const octets = match.slice(1, 5).map(Number);
    const port = Number(match[5]);
    if (octets.some((octet) => octet > 255) || port < 1 || port > 65535) continue;
    into.add(`${octets.join(".")}:${port}`);
  }
}

async function readKnownProxies() {
  const known = new Set<string>();
  for (const line of (await Bun.file(RAW_PROXY_LIST_FILE).text()).split("\n")) {
    const [address, port] = line.trim().split(",");
    if (address && port) known.add(`${address}:${port}`);
  }
  return known;
}

const known = await readKnownProxies();
const found = new Set<string>();
let reachableSources = 0;

for (const source of SOURCES) {
  try {
    const response = await fetch(source, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    const before = found.size;
    parseSource(await response.text(), found);
    reachableSources += 1;
    console.log(`[source] ${source}: +${found.size - before}`);
  } catch (error: any) {
    console.warn(`[source] ${source}: failed (${error.message})`);
  }
}

if (reachableSources === 0) throw new Error("All proxy sources failed");

const candidates = [...found]
  .filter((proxy) => !known.has(proxy))
  .sort((a, b) => a.localeCompare(b, "en", { numeric: true }));

await Bun.write(CANDIDATE_LIST_FILE, candidates.length ? `${candidates.join("\n")}\n` : "");

console.log(`Known: ${known.size}, fetched: ${found.size}, new: ${candidates.length}`);
