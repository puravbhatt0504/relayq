import * as cdk from "aws-cdk-lib";
import * as appscaling from "aws-cdk-lib/aws-applicationautoscaling";
import * as cloudwatch from "aws-cdk-lib/aws-cloudwatch";
import * as ec2 from "aws-cdk-lib/aws-ec2";
import * as ecs from "aws-cdk-lib/aws-ecs";
import * as patterns from "aws-cdk-lib/aws-ecs-patterns";
import * as elasticache from "aws-cdk-lib/aws-elasticache";
import * as iam from "aws-cdk-lib/aws-iam";
import * as logs from "aws-cdk-lib/aws-logs";
import * as rds from "aws-cdk-lib/aws-rds";
import * as s3 from "aws-cdk-lib/aws-s3";
import * as secrets from "aws-cdk-lib/aws-secretsmanager";
import type { Construct } from "constructs";
import { fileURLToPath } from "node:url";

const REPO_ROOT = fileURLToPath(new URL("../..", import.meta.url));

/**
 * RelayQ on ECS Fargate, sized for a short-lived demo: no NAT gateway (tasks get public IPs in
 * public subnets; data stores sit in isolated subnets), t4g.micro RDS + ElastiCache, no backups,
 * everything DESTROY-on-delete so `cdk destroy` / the reaper leaves nothing billable behind.
 */
export class RelayQStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);
    const destroy = cdk.RemovalPolicy.DESTROY;

    const vpc = new ec2.Vpc(this, "Vpc", {
      maxAzs: 2,
      natGateways: 0,
      subnetConfiguration: [
        { name: "public", subnetType: ec2.SubnetType.PUBLIC },
        { name: "data", subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      ],
    });
    const tasksSg = new ec2.SecurityGroup(this, "TasksSg", { vpc });

    // Postgres. Password limited to URL-safe characters so it can sit in DATABASE_URL unescaped.
    const dbSg = new ec2.SecurityGroup(this, "DbSg", { vpc });
    dbSg.addIngressRule(tasksSg, ec2.Port.tcp(5432));
    const db = new rds.DatabaseInstance(this, "Postgres", {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_16 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc, vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED }, securityGroups: [dbSg],
      databaseName: "relayq",
      credentials: rds.Credentials.fromGeneratedSecret("relayq", { excludeCharacters: " %+~`#$&*()|[]{}:;<>?!'/@\"\\,=^." }),
      allocatedStorage: 20,
      storageEncrypted: true,
      backupRetention: cdk.Duration.days(0),
      deleteAutomatedBackups: true,
      deletionProtection: false,
      removalPolicy: destroy,
    });

    // Redis (BullMQ). Default parameter group = volatile-lru: BullMQ keys have no TTL, so they're never evicted.
    const redisSg = new ec2.SecurityGroup(this, "RedisSg", { vpc });
    redisSg.addIngressRule(tasksSg, ec2.Port.tcp(6379));
    const redisSubnets = new elasticache.CfnSubnetGroup(this, "RedisSubnets", {
      description: "relayq redis",
      subnetIds: vpc.isolatedSubnets.map((s) => s.subnetId),
    });
    const redis = new elasticache.CfnCacheCluster(this, "Redis", {
      engine: "redis", engineVersion: "7.1", cacheNodeType: "cache.t4g.micro", numCacheNodes: 1,
      cacheSubnetGroupName: redisSubnets.ref, vpcSecurityGroupIds: [redisSg.securityGroupId],
    });

    const exports = new s3.Bucket(this, "Exports", {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [{ expiration: cdk.Duration.days(7) }],
      autoDeleteObjects: true, removalPolicy: destroy,
    });
    const appSecret = new secrets.Secret(this, "AppSecret", {
      generateSecretString: { secretStringTemplate: "{}", generateStringKey: "WEBHOOK_SECRET", excludePunctuation: true },
      removalPolicy: destroy,
    });
    const adminSecret = new secrets.Secret(this, "AdminPassword", {
      generateSecretString: { excludePunctuation: true, passwordLength: 24 },
      removalPolicy: destroy,
    });

    const image = ecs.ContainerImage.fromAsset(REPO_ROOT, { platform: cdk.aws_ecr_assets.Platform.LINUX_AMD64 });
    const cluster = new ecs.Cluster(this, "Cluster", { vpc });
    const env = {
      REDIS_URL: `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`,
      EXPORT_BUCKET: exports.bucketName,
      MAIL_FROM: "relayq@example.com",
      TENANT_JOBS_PER_MIN: "100",
      WORKER_CONCURRENCY: "5",
    };
    const appSecrets = {
      DB_PASSWORD: ecs.Secret.fromSecretsManager(db.secret!, "password"),
      WEBHOOK_SECRET: ecs.Secret.fromSecretsManager(appSecret, "WEBHOOK_SECRET"),
    };
    // DATABASE_URL is assembled at start so the password never appears in the task definition.
    const dbUrl = `postgresql://relayq:$DB_PASSWORD@${db.dbInstanceEndpointAddress}:5432/relayq`;
    const logGroup = (name: string) =>
      new logs.LogGroup(this, `${name}Logs`, { retention: logs.RetentionDays.ONE_WEEK, removalPolicy: destroy });
    const grantAppPermissions = (role: iam.IRole) => {
      exports.grantReadWrite(role);
      role.addToPrincipalPolicy(new iam.PolicyStatement({ actions: ["ses:SendEmail", "ses:SendRawEmail"], resources: ["*"] }));
    };

    // API (+ outbox relay + public demo) behind a public ALB.
    // ponytail: plain HTTP. CloudFront (free HTTPS on *.cloudfront.net) is blocked until AWS verifies the
    // account; once it is, front the ALB with a Distribution and restrict the ALB SG to the
    // com.amazonaws.global.cloudfront.origin-facing prefix list (pl-9aa247f3 in ap-south-1).
    const api = new patterns.ApplicationLoadBalancedFargateService(this, "Api", {
      cluster, cpu: 256, memoryLimitMiB: 512, desiredCount: 1, minHealthyPercent: 100,
      assignPublicIp: true, taskSubnets: { subnetType: ec2.SubnetType.PUBLIC }, securityGroups: [tasksSg],
      taskImageOptions: {
        image, containerPort: 3200,
        command: ["sh", "-c", `export DATABASE_URL="${dbUrl}" && node_modules/.bin/prisma migrate deploy && exec node dist/api/server.js`],
        environment: { ...env, DEMO: "1", EMF_NAMESPACE: "RelayQ", ADMIN_USER: "admin" },
        secrets: { ...appSecrets, ADMIN_PASSWORD: ecs.Secret.fromSecretsManager(adminSecret) },
        logDriver: ecs.LogDrivers.awsLogs({ streamPrefix: "api", logGroup: logGroup("Api") }),
      },
      circuitBreaker: { rollback: true },
    });
    api.targetGroup.configureHealthCheck({ path: "/health", healthyHttpCodes: "200" });
    api.targetGroup.setAttribute("deregistration_delay.timeout_seconds", "10");
    grantAppPermissions(api.taskDefinition.taskRole);

    // Demo jobs run in worker tasks, which reach the api's sink through the ALB like any client.
    const url = `http://${api.loadBalancer.loadBalancerDnsName}`;
    api.taskDefinition.defaultContainer!.addEnvironment("DEMO_SINK_URL", `${url}/demo/sink`);

    // Workers: 1 to 3 tasks, scaled on the QueueDepth metric the api emits every 30 s.
    const workerTask = new ecs.FargateTaskDefinition(this, "WorkerTask", { cpu: 256, memoryLimitMiB: 512 });
    workerTask.addContainer("worker", {
      image,
      command: ["sh", "-c", `export DATABASE_URL="${dbUrl}" && exec node dist/worker/index.js`],
      environment: env,
      secrets: appSecrets,
      logging: ecs.LogDrivers.awsLogs({ streamPrefix: "worker", logGroup: logGroup("Worker") }),
      stopTimeout: cdk.Duration.seconds(35), // worker drains for up to 30 s on SIGTERM
    });
    grantAppPermissions(workerTask.taskRole);
    const worker = new ecs.FargateService(this, "Worker", {
      cluster, taskDefinition: workerTask, desiredCount: 1, minHealthyPercent: 100,
      assignPublicIp: true, vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC }, securityGroups: [tasksSg],
      circuitBreaker: { rollback: true },
    });
    worker.autoScaleTaskCount({ minCapacity: 1, maxCapacity: 3 }).scaleOnMetric("QueueDepth", {
      metric: new cloudwatch.Metric({ namespace: "RelayQ", metricName: "QueueDepth", statistic: "Maximum", period: cdk.Duration.minutes(1) }),
      scalingSteps: [{ upper: 50, change: -1 }, { lower: 500, change: +1 }, { lower: 2000, change: +2 }],
      adjustmentType: appscaling.AdjustmentType.CHANGE_IN_CAPACITY,
      cooldown: cdk.Duration.seconds(60),
    });

    new cdk.CfnOutput(this, "Url", { value: url });
    new cdk.CfnOutput(this, "AdminPasswordSecret", { value: adminSecret.secretName });
    new cdk.CfnOutput(this, "ClusterName", { value: cluster.clusterName });
  }
}
