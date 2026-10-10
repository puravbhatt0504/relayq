// 50 VUs enqueue webhook.deliver jobs (pointed at a local sink) as fast as the API accepts them.
// 429 (tenant backlog cap) is expected back-pressure, not an error; only 202s count as enqueued.
import http from "k6/http";
import { check } from "k6";
import { Counter } from "k6/metrics";

const accepted = new Counter("jobs_accepted");
const rejected = new Counter("jobs_rejected_429");

export const options = {
  vus: 50,
  duration: __ENV.DURATION || "5m",
  thresholds: { checks: ["rate==1"] },
};

const params = {
  headers: { "content-type": "application/json", authorization: `Bearer ${__ENV.RELAYQ_KEY}` },
  responseCallback: http.expectedStatuses(202, 429),
  tags: { name: "POST /jobs" },
};

export default function () {
  const body = JSON.stringify({ type: "webhook.deliver", payload: { url: __ENV.SINK_URL, body: { vu: __VU, iter: __ITER } } });
  const res = http.post(`${__ENV.RELAYQ_URL}/jobs`, body, params);
  if (res.status === 202) accepted.add(1);
  if (res.status === 429) rejected.add(1);
  check(res, { "202 or 429": (r) => r.status === 202 || r.status === 429 });
}
