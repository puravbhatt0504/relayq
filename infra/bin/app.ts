import * as cdk from "aws-cdk-lib";
import { ReaperStack } from "../lib/reaper-stack.js";
import { RelayQStack } from "../lib/relayq-stack.js";

const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: "ap-south-1" };
const app = new cdk.App();

new RelayQStack(app, "RelayQ", { env });

// DESTROY_AT (ISO, UTC) pins the deadline across redeploys; default is 5 days from this deploy.
const destroyAt = process.env.DESTROY_AT ? new Date(process.env.DESTROY_AT) : new Date(Date.now() + 5 * 86_400_000);
if (!process.env.ALERT_EMAIL) throw new Error("set ALERT_EMAIL for the budget alert");
new ReaperStack(app, "RelayQReaper", { env, targetStackName: "RelayQ", destroyAt, alertEmail: process.env.ALERT_EMAIL, budgetUsd: 25 });
