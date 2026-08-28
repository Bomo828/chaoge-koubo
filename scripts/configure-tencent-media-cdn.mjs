#!/usr/bin/env node

import crypto from "node:crypto";

const domain = process.env.MEDIA_CDN_DOMAIN?.trim() || "media.chaogeai.top";
const rootDomain = process.env.MEDIA_CDN_ROOT_DOMAIN?.trim() || "chaogeai.top";
const subDomain = process.env.MEDIA_CDN_SUBDOMAIN?.trim() || "media";
const bucket = process.env.TENCENT_MPS_COS_BUCKET?.trim();
const region = process.env.TENCENT_MPS_COS_REGION?.trim() || "ap-guangzhou";
const secretId = process.env.TENCENT_CLOUD_SECRET_ID?.trim();
const secretKey = process.env.TENCENT_CLOUD_SECRET_KEY?.trim();
const apply = process.argv.includes("--apply");
const whoami = process.argv.includes("--whoami");
const requestCertificate = process.argv.includes("--request-certificate");
const purgePublicMedia = process.argv.includes("--purge-public-media");

const publicMediaPaths = [
  "/media/ai-assistant-avatar.svg",
  "/media/flash-lab-hero-20260808.mp4",
  "/media/flash-lab-hero-poster.jpg",
  "/media/flash-lab-logo.png",
  "/media/flash-lab-title-lockup.png",
  "/media/image-lab/editorial-collage.png",
  "/media/image-lab/product-hero.png",
  "/media/image-lab/store-scene.png",
  "/template-covers/template-9.jpg",
  "/template-covers/template-10.jpg",
  "/template-covers/template-11.jpg",
  "/template-covers/template-12.jpg",
];

for (const [name, value] of Object.entries({
  TENCENT_MPS_COS_BUCKET: bucket,
  TENCENT_CLOUD_SECRET_ID: secretId,
  TENCENT_CLOUD_SECRET_KEY: secretKey,
})) {
  if (!value) throw new Error(`Missing required environment variable: ${name}`);
}

const sha256 = (value) => crypto.createHash("sha256").update(value).digest("hex");
const hmac = (key, value, encoding) => crypto.createHmac("sha256", key).update(value).digest(encoding);

async function tcApi({ service, host, action, version, body = {}, region: apiRegion }) {
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().slice(0, 10);
  const payload = JSON.stringify(body);
  const canonicalHeaders = `content-type:application/json; charset=utf-8\nhost:${host}\n`;
  const signedHeaders = "content-type;host";
  const canonicalRequest = [
    "POST",
    "/",
    "",
    canonicalHeaders,
    signedHeaders,
    sha256(payload),
  ].join("\n");
  const credentialScope = `${date}/${service}/tc3_request`;
  const stringToSign = [
    "TC3-HMAC-SHA256",
    timestamp,
    credentialScope,
    sha256(canonicalRequest),
  ].join("\n");
  const secretDate = hmac(`TC3${secretKey}`, date);
  const secretService = hmac(secretDate, service);
  const secretSigning = hmac(secretService, "tc3_request");
  const signature = hmac(secretSigning, stringToSign, "hex");
  const authorization = [
    `TC3-HMAC-SHA256 Credential=${secretId}/${credentialScope}`,
    `SignedHeaders=${signedHeaders}`,
    `Signature=${signature}`,
  ].join(", ");
  const headers = {
    Authorization: authorization,
    "Content-Type": "application/json; charset=utf-8",
    Host: host,
    "X-TC-Action": action,
    "X-TC-Timestamp": String(timestamp),
    "X-TC-Version": version,
  };
  if (apiRegion) headers["X-TC-Region"] = apiRegion;

  const response = await fetch(`https://${host}`, {
    method: "POST",
    headers,
    body: payload,
  });
  const json = await response.json();
  if (json?.Response?.Error) {
    const error = new Error(`${action}: ${json.Response.Error.Code}: ${json.Response.Error.Message}`);
    error.code = json.Response.Error.Code;
    throw error;
  }
  return json.Response;
}

const cdnApi = (action, body = {}) => tcApi({
  service: "cdn",
  host: "cdn.tencentcloudapi.com",
  action,
  version: "2018-06-06",
  body,
});

const dnsApi = (action, body = {}) => tcApi({
  service: "dnspod",
  host: "dnspod.tencentcloudapi.com",
  action,
  version: "2021-03-23",
  body,
});

const sslApi = (action, body = {}) => tcApi({
  service: "ssl",
  host: "ssl.tencentcloudapi.com",
  action,
  version: "2019-12-05",
  body,
});

const stsApi = (action, body = {}) => tcApi({
  service: "sts",
  host: "sts.tencentcloudapi.com",
  action,
  version: "2018-08-13",
  body,
  region: "ap-guangzhou",
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function getCdnDomain() {
  const response = await cdnApi("DescribeDomainsConfig", { Offset: 0, Limit: 100 });
  return (response.Domains || []).find((item) => item.Domain === domain) || null;
}

function certificateCovers(cert, hostname) {
  const names = new Set([
    cert.Domain,
    ...(cert.SubjectAltName || []),
    ...(cert.CertSANs || []),
  ].filter(Boolean).map((value) => String(value).toLowerCase()));
  const target = hostname.toLowerCase();
  if (names.has(target)) return true;
  return [...names].some((name) => {
    if (!name.startsWith("*.")) return false;
    const suffix = name.slice(1);
    return target.endsWith(suffix) && target.split(".").length === name.split(".").length;
  });
}

async function getCertificateCandidates() {
  const response = await sslApi("DescribeCertificates", {
    Offset: 0,
    Limit: 100,
    SearchKey: rootDomain,
    CertificateType: "SVR",
    ExpirationSort: "DESC",
  });
  return (response.Certificates || []).filter((cert) => certificateCovers(cert, domain));
}

async function getCertificate() {
  const candidates = await getCertificateCandidates();
  return candidates.find((cert) => cert.Status === 1) || null;
}

async function getDnsRecords({ host = subDomain, type = "CNAME" } = {}) {
  try {
    const response = await dnsApi("DescribeRecordList", {
      Domain: rootDomain,
      Subdomain: host,
      RecordType: type,
      Offset: 0,
      Limit: 100,
    });
    return response.RecordList || [];
  } catch (error) {
    // DNSPod reports an empty record set as an API error instead of an empty list.
    if (error?.code === "ResourceNotFound.NoDataOfRecord") return [];
    throw error;
  }
}

async function verifyDomainOwnership() {
  const verifyRecord = await cdnApi("CreateVerifyRecord", { Domain: domain });
  const verifyHost = verifyRecord.SubDomain || "_cdnauth";
  const verifyType = verifyRecord.RecordType || "TXT";
  const verifyValue = verifyRecord.Record;
  if (!verifyValue) throw new Error("CDN did not return a domain verification record.");

  const verifyRecords = await getDnsRecords({ host: verifyHost, type: verifyType });
  const existing = verifyRecords[0];
  if (!existing) {
    await dnsApi("CreateRecord", {
      Domain: rootDomain,
      SubDomain: verifyHost,
      RecordType: verifyType,
      RecordLine: "默认",
      Value: verifyValue,
      TTL: 600,
      Status: "ENABLE",
    });
    console.log("CDN_OWNERSHIP_RECORD_CREATED");
  } else if (existing.Value !== verifyValue || existing.Status !== "ENABLE") {
    await dnsApi("ModifyRecord", {
      Domain: rootDomain,
      RecordId: existing.RecordId,
      SubDomain: verifyHost,
      RecordType: verifyType,
      RecordLine: existing.Line || "默认",
      Value: verifyValue,
      TTL: 600,
      Status: "ENABLE",
    });
    console.log("CDN_OWNERSHIP_RECORD_UPDATED");
  } else {
    console.log("CDN_OWNERSHIP_RECORD_UNCHANGED");
  }

  for (let attempt = 0; attempt < 24; attempt += 1) {
    try {
      const result = await cdnApi("VerifyDomainRecord", { Domain: domain, VerifyType: "dns" });
      if (result.Result === true) {
        console.log("CDN_DOMAIN_OWNERSHIP_VERIFIED");
        return;
      }
    } catch (error) {
      if (error?.code !== "UnauthorizedOperation.CdnTxtRecordValueNotMatch") throw error;
    }
    await sleep(5000);
  }
  throw new Error("CDN domain ownership TXT record did not propagate within 120 seconds.");
}

async function waitForCdnDomain() {
  for (let attempt = 0; attempt < 18; attempt += 1) {
    const current = await getCdnDomain();
    if (current?.Cname) return current;
    await sleep(5000);
  }
  throw new Error("CDN domain was added but no CNAME was allocated within 90 seconds.");
}

async function modifyDomain(route, update) {
  return cdnApi("ModifyDomainConfig", {
    Domain: domain,
    Route: route,
    Value: JSON.stringify({ update }),
  });
}

async function main() {
  if (purgePublicMedia) {
    const urls = publicMediaPaths.flatMap((pathname) => [
      `http://${domain}${pathname}`,
      `https://${domain}${pathname}`,
    ]);
    const response = await cdnApi("PurgeUrlsCache", { Urls: urls, Area: "mainland" });
    console.log(JSON.stringify({
      result: "purge-submitted",
      taskId: response.TaskId || null,
      urls: urls.length,
    }, null, 2));
    return;
  }

  if (whoami) {
    const identity = await stsApi("GetCallerIdentity");
    console.log(JSON.stringify({
      accountId: identity.AccountId || null,
      principalId: identity.PrincipalId || null,
      type: identity.Type || null,
      userId: identity.UserId || null,
    }, null, 2));
    return;
  }

  if (requestCertificate) {
    const candidates = await getCertificateCandidates();
    const issued = candidates.find((cert) => cert.Status === 1);
    if (issued) {
      console.log(JSON.stringify({ result: "already-issued", certificateId: issued.CertificateId }, null, 2));
      return;
    }
    const pending = candidates.find((cert) => [0, 4, 13].includes(cert.Status));
    if (pending) {
      console.log(JSON.stringify({
        result: "pending",
        certificateId: pending.CertificateId,
        status: pending.Status,
        statusName: pending.StatusName || null,
      }, null, 2));
      return;
    }
    const requested = await sslApi("ApplyCertificate", {
      DvAuthMethod: "DNS_AUTO",
      DomainName: domain,
    });
    console.log(JSON.stringify({ result: "requested", certificateId: requested.CertificateId }, null, 2));
    return;
  }

  let current = await getCdnDomain();
  const certificate = await getCertificate();
  let records = await getDnsRecords();

  console.log(JSON.stringify({
    mode: apply ? "apply" : "inspect",
    domain,
    originBucket: bucket,
    originRegion: region,
    publicOriginPrefix: "/public",
    cdnConfigured: Boolean(current),
    cdnStatus: current?.Status || null,
    cname: current?.Cname || null,
    httpsEnabled: current?.Https?.Switch === "on",
    forceHttpsEnabled: current?.ForceRedirect?.Switch === "on" && current?.ForceRedirect?.RedirectType === "https",
    certificateAvailable: Boolean(certificate),
    certificateDomain: certificate?.Domain || null,
    certificateExpiresAt: certificate?.CertEndTime || null,
    dnsRecords: records.map((record) => ({
      id: record.RecordId,
      type: record.Type,
      value: record.Value,
      status: record.Status,
    })),
  }, null, 2));

  if (!apply) return;

  const originHost = `${bucket}.cos.${region}.myqcloud.com`;
  if (!current) {
    const addDomain = async () => cdnApi("AddCdnDomain", {
        Domain: domain,
        ServiceType: "media",
        Area: "mainland",
        Origin: {
          Origins: [originHost],
          OriginType: "cos",
          ServerName: originHost,
          CosPrivateAccess: "on",
          OriginPullProtocol: "https",
          BasePath: "/public",
        },
        ProjectId: 0,
      });
    try {
      await addDomain();
    } catch (error) {
      if (error?.code !== "UnauthorizedOperation.CdnDomainRecordNotVerified") throw error;
      await verifyDomainOwnership();
      await addDomain();
    }
    console.log("CDN_DOMAIN_ADDED");
    current = await waitForCdnDomain();
  }

  const cname = current.Cname;
  if (!cname) throw new Error("CDN domain has no CNAME target.");
  const normalizedCname = cname.endsWith(".") ? cname : `${cname}.`;
  const existing = records[0];
  if (!existing) {
    await dnsApi("CreateRecord", {
      Domain: rootDomain,
      SubDomain: subDomain,
      RecordType: "CNAME",
      RecordLine: "默认",
      Value: normalizedCname,
      TTL: 600,
      Status: "ENABLE",
    });
    console.log("DNS_CNAME_CREATED");
  } else if (String(existing.Value).replace(/\.$/, "") !== cname.replace(/\.$/, "") || existing.Status !== "ENABLE") {
    await dnsApi("ModifyRecord", {
      Domain: rootDomain,
      RecordId: existing.RecordId,
      SubDomain: subDomain,
      RecordType: "CNAME",
      RecordLine: existing.Line || "默认",
      Value: normalizedCname,
      TTL: 600,
      Status: "ENABLE",
    });
    console.log("DNS_CNAME_UPDATED");
  } else {
    console.log("DNS_CNAME_UNCHANGED");
  }

  if (!certificate) {
    console.log("HTTPS_SKIPPED_NO_MATCHING_CERTIFICATE");
  } else {
    await modifyDomain("Https.CertInfo.CertId", certificate.CertificateId);
    await modifyDomain("Https.Switch", "on");
    await modifyDomain("Https.Http2", "on");
    await modifyDomain("ForceRedirect", {
      Switch: "on",
      RedirectType: "https",
      RedirectStatusCode: 301,
      CarryHeaders: "off",
    });
    console.log("HTTPS_AND_REDIRECT_CONFIGURED");
  }

  records = await getDnsRecords();
  current = await getCdnDomain();
  console.log(JSON.stringify({
    result: "completed",
    domain,
    cname: current?.Cname || null,
    cdnStatus: current?.Status || null,
    httpsEnabled: current?.Https?.Switch === "on",
    forceHttpsEnabled: current?.ForceRedirect?.Switch === "on" && current?.ForceRedirect?.RedirectType === "https",
    dnsConfigured: records.some((record) => String(record.Value).replace(/\.$/, "") === String(current?.Cname).replace(/\.$/, "")),
  }, null, 2));
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
