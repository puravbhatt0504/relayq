import * as cdk from "aws-cdk-lib";
import * as budgets from "aws-cdk-lib/aws-budgets";
import * as iam from "aws-cdk-lib/aws-iam";
import * as scheduler from "aws-cdk-lib/aws-scheduler";
import type { Construct } from "constructs";

type Props = cdk.StackProps & { targetStackName: string; destroyAt: Date; alertEmail: string; budgetUsd: number };

/**
 * Safety net that outlives the app stack and costs nothing: a one-time EventBridge Scheduler
 * call to cloudformation:DeleteStack at `destroyAt` (runs in AWS, laptop can be off), plus a
 * monthly cost budget that emails at 80% and 100% of `budgetUsd` (usage before credits).
 *
 * The scheduler role only needs DeleteStack: CDK deploys the app stack with its bootstrap
 * cfn-exec-role, and CloudFormation uses that stack role for the deletion itself.
 */
export class ReaperStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: Props) {
    super(scope, id, props);
    const stackArn = `arn:aws:cloudformation:${this.region}:${this.account}:stack/${props.targetStackName}/*`;

    const role = new iam.Role(this, "DeleteRole", {
      assumedBy: new iam.ServicePrincipal("scheduler.amazonaws.com", {
        conditions: { StringEquals: { "aws:SourceAccount": this.account } },
      }),
    });
    role.addToPolicy(new iam.PolicyStatement({ actions: ["cloudformation:DeleteStack"], resources: [stackArn] }));

    const at = props.destroyAt.toISOString().slice(0, 19); // at(yyyy-mm-ddThh:mm:ss), UTC
    new scheduler.CfnSchedule(this, "DestroyAppStack", {
      description: `Deletes ${props.targetStackName} at ${at} UTC`,
      scheduleExpression: `at(${at})`,
      scheduleExpressionTimezone: "UTC",
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        arn: "arn:aws:scheduler:::aws-sdk:cloudformation:deleteStack",
        roleArn: role.roleArn,
        input: JSON.stringify({ StackName: props.targetStackName }),
        retryPolicy: { maximumRetryAttempts: 10, maximumEventAgeInSeconds: 86400 },
      },
    });

    new budgets.CfnBudget(this, "Budget", {
      budget: {
        budgetName: "relayq-demo",
        budgetType: "COST",
        timeUnit: "MONTHLY",
        budgetLimit: { amount: props.budgetUsd, unit: "USD" },
        costTypes: { includeCredit: false, includeRefund: false }, // measure usage even though credits pay for it
      },
      notificationsWithSubscribers: [80, 100].map((threshold) => ({
        notification: { notificationType: "ACTUAL", comparisonOperator: "GREATER_THAN", threshold, thresholdType: "PERCENTAGE" },
        subscribers: [{ subscriptionType: "EMAIL", address: props.alertEmail }],
      })),
    });

    new cdk.CfnOutput(this, "DestroyAt", { value: `${at} UTC` });
  }
}
