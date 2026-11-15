import tls from "tls";

interface ProxyStruct {
  address: string;
  port: number;
  country: string;
  org: string;
}

interface ProxyTestResult {
  error: boolean;
  message?: string;
  result?: {
    proxy: string;
    proxyip: boolean;
    ip: string;
    port: number;
    delay: number;
    country: string;
    asOrganization: string;
  };
}

let myGeoIpString: any = null;

const KV_PAIR_PROXY_FILE = "./ProxyList.json";
const RAW_PROXY_LIST_FILE = "./ProxyRaw.txt";
const CANDIDATE_LIST_FILE = "./ProxyCandidate.txt";
const PROXY_LIST_FILE = "./ProxyList.txt";
const IP_RESOLVER_DOMAIN = "myip.ipeek.workers.dev";
const IP_RESOLVER_PATH = "/";
const CONCURRENCY = 99;

const CHECK_QUEUE: string[] = [];

async function sendRequest(host: string, path: string, proxy: any = null) {
  return new Promise((resolve, reject) => {
    const options = {
      host: proxy ? proxy.host : host,
      port: proxy ? proxy.port : 443,
      servername: host,
    };

    const socket = tls.connect(options, () => {
      const request =
        `GET ${path} HTTP/1.1\r\n` + `Host: ${host}\r\n` + `User-Agent: Mozilla/5.0\r\n` + `Connection: close\r\n\r\n`;
      socket.write(request);
    });

    let responseBody = "";

    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("socket timeout"));
    }, 5000);

    socket.on("data", (data) => (responseBody += data.toString()));
    socket.on("end", () => {
      clearTimeout(timeout);
      const body = responseBody.split("\r\n\r\n")[1] || "";
      resolve(body);
    });
    socket.on("error", (error) => {
      // console.log(error);
      reject(error);
    });
  });
}

export async function checkProxy(proxyAddress: string, proxyPort: number): Promise<ProxyTestResult> {
  let result: ProxyTestResult = {
    message: "Unknown error",
    error: true,
  };

  const proxyInfo = { host: proxyAddress, port: proxyPort };

  try {
    const start = new Date().getTime();
    const [ipinfo, myip] = await Promise.all([
      sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, proxyInfo),
      myGeoIpString == null ? sendRequest(IP_RESOLVER_DOMAIN, IP_RESOLVER_PATH, null) : myGeoIpString,
    ]);
    const finish = new Date().getTime();

    if (myGeoIpString == null) myGeoIpString = myip;

    const parsedIpInfo = JSON.parse(ipinfo as string);
    const parsedMyIp = JSON.parse(myip as string);

    if (parsedIpInfo.ip && parsedIpInfo.ip !== parsedMyIp.ip) {
      result = {
        error: false,
        result: {
          proxy: proxyAddress,
          port: proxyPort,
          proxyip: true,
          delay: finish - start,
          ...parsedIpInfo,
        },
      };
    }
  } catch (error: any) {
    result.message = error.message;
  }

  return result;
}

// async function checkProxy(proxyAddress: string, proxyPort: number): Promise<ProxyTestResult> {
//   const controller = new AbortController();
//   setTimeout(() => controller.abort(), 5000);

//   try {
//     const res = await Bun.fetch(IP_RESOLVER_DOMAIN + `?ip=${proxyAddress}:${proxyPort}`, {
//       signal: controller.signal,
//     });

//     if (res.status == 200) {
//       return {
//         error: false,
//         result: await res.json(),
//       };
//     } else {
//       throw new Error(res.statusText);
//     }
//   } catch (e: any) {
//     return {
//       error: true,
//       message: e.message,
//     };
//   }
// }

async function readProxyList(): Promise<ProxyStruct[]> {
  const proxyList: ProxyStruct[] = [];

  const proxyListString = (await Bun.file(RAW_PROXY_LIST_FILE).text()).split("\n");
  for (const proxy of proxyListString) {
    const [address, port, country, org] = proxy.split(",");
    if (!address || !port) continue;
    proxyList.push({
      address,
      port: parseInt(port),
      country: country ?? "",
      org: org ?? "",
    });
  }

  return proxyList;
}

async function readCandidates(): Promise<ProxyStruct[]> {
  const file = Bun.file(CANDIDATE_LIST_FILE);
  if (!(await file.exists())) return [];

  const candidateList: ProxyStruct[] = [];
  for (const candidate of (await file.text()).split("\n")) {
    const [address, port] = candidate.trim().split(":");
    if (address && port) candidateList.push({ address, port: parseInt(port), country: "", org: "" });
  }

  return candidateList;
}

(async () => {
  const rawProxyList = await readProxyList();
  const candidateList = await readCandidates();
  const proxyList = [...rawProxyList, ...candidateList];
  const proxyChecked: string[] = [];
  const uniqueRawProxies: string[] = [];
  const activeProxyList: string[] = [];
  const kvPair: any = {};

  let proxySaved = 0;

  for (const [i, proxy] of proxyList.entries()) {
    const proxyKey = `${proxy.address}:${proxy.port}`;
    if (proxyChecked.includes(proxyKey)) continue;
    proxyChecked.push(proxyKey);

    CHECK_QUEUE.push(proxyKey);
    checkProxy(proxy.address, proxy.port)
      .then((res) => {
        if (!res.error && res.result?.proxyip === true && res.result.country) {
          activeProxyList.push(
            `${res.result?.proxy},${res.result?.port},${res.result?.country},${res.result?.asOrganization}`
          );

          if (kvPair[res.result.country] == undefined) kvPair[res.result.country] = [];
          if (kvPair[res.result.country].length < 10) {
            kvPair[res.result.country].push(`${res.result.proxy}:${res.result.port}`);
          }

          uniqueRawProxies.push(
            `${res.result.proxy},${res.result.port},${res.result.country},${res.result.asOrganization}`
          );

          proxySaved += 1;
          console.log(`[${i}/${proxyList.length}] Proxies saved:`, proxySaved);
        }
      })
      .finally(() => {
        CHECK_QUEUE.pop();
      });

    while (CHECK_QUEUE.length >= CONCURRENCY) {
      await Bun.sleep(1);
    }
  }

  while (CHECK_QUEUE.length) {
    await Bun.sleep(1);
  }

  uniqueRawProxies.sort(sortByCountry);
  activeProxyList.sort(sortByCountry);

  await Bun.write(KV_PAIR_PROXY_FILE, JSON.stringify(kvPair, null, "  "));
  await Bun.write(RAW_PROXY_LIST_FILE, uniqueRawProxies.join("\n"));
  await Bun.write(PROXY_LIST_FILE, activeProxyList.join("\n"));
  await Bun.write(CANDIDATE_LIST_FILE, "");

  console.log(`Processing time: ${(Bun.nanoseconds() / 1000000000).toFixed(2)}s`);
  process.exit(0);
})();

function sortByCountry(a: string, b: string) {
  const countryA = a.split(",")[2] ?? "";
  const countryB = b.split(",")[2] ?? "";

  return countryA.localeCompare(countryB);
}
