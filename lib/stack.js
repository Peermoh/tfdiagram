// "stack.json" files describe a platform pattern as capability lists per tier instead of Terraform resources:
//   { "stack": { "cloud_routing": { "network": [ { "capability_name": "Cloud DNS", "include": ["GTS-1150-Amazon Route 53"] } ] },
//                "cloud_account": { "tier-2": { "compute": [ ... ] }, "non-vpc": { ... } }, "cloud_platform": { ... } } }
// This turns one into a model the page draws as tier boxes with service icons.

const SERVICES = [
  [/network load balanc|\bNLB\b/i, 'Network Load Balancer (NLB)', 'aws_lb'],
  [/elastic load balanc|\bELB\b|application load balanc|\bALB\b/i, 'Elastic Load Balancing (ELB)', 'aws_lb'],
  [/route\s*53/i, 'Amazon Route 53', 'aws_route53_zone'],
  [/direct\s*connect/i, 'AWS Direct Connect', 'aws_dx_connection'],
  [/auto\s*scaling/i, 'AWS Auto Scaling', 'aws_autoscaling_group'],
  [/\bEC2\b/i, 'Amazon EC2', 'aws_instance'],
  [/simple storage|\bS3\b/i, 'Amazon S3', 'aws_s3_bucket'],
  [/block store|\bEBS\b/i, 'Amazon EBS', 'aws_ebs_volume'],
  [/elastic file system|\bEFS\b/i, 'Amazon EFS', 'aws_efs_file_system'],
  [/secrets manager/i, 'AWS Secrets Manager', 'aws_secretsmanager_secret'],
  [/key management|\bKMS\b/i, 'AWS KMS', 'aws_kms_key'],
  [/certificate manager|\bACM\b/i, 'AWS Certificate Manager', 'aws_acm_certificate'],
  [/systems manager|\bSSM\b/i, 'AWS Systems Manager', 'aws_ssm_parameter'],
  [/cloudwatch/i, 'Amazon CloudWatch', 'aws_cloudwatch_log_group'],
  [/cloudtrail/i, 'AWS CloudTrail', 'aws_cloudtrail'],
  [/opensearch|elasticsearch/i, 'Amazon OpenSearch Service', 'aws_opensearch_domain'],
  [/\bRDS\b/i, null, 'aws_db_instance'],
  [/dynamodb/i, 'Amazon DynamoDB', 'aws_dynamodb_table'],
  [/\blambda\b/i, 'AWS Lambda', 'aws_lambda_function'],
  [/\bSQS\b|simple queue/i, 'Amazon SQS', 'aws_sqs_queue'],
  [/\bSNS\b|simple notification/i, 'Amazon SNS', 'aws_sns_topic'],
  [/\bEKS\b|kubernetes service/i, 'Amazon EKS', 'aws_eks_cluster'],
  [/cloudfront/i, 'Amazon CloudFront', 'aws_cloudfront_distribution'],
  [/\bWAF\b/i, 'AWS WAF', 'aws_wafv2_web_acl'],
];

const ACR = { vpc: 'VPC', dns: 'DNS' };
const humanize = (k) => /^non[-_]vpc$/i.test(k) ? 'Non-VPC' : String(k).replace(/[-_]+/g, ' ').trim().split(' ').map((w, i) => ACR[w.toLowerCase()] ?? (i === 0 ? w[0].toUpperCase() + w.slice(1) : w)).join(' ');
const clean = (s) => String(s).replace(/^\s*(?:GTS-)?\d+-/, '').replace(/\s*\((?:successor to|formerly)[^)]*\)\s*/i, ' ').replace(/\s+/g, ' ').trim();

export function classifyService(raw) {
  const text = clean(raw);
  for (const [re, label, type] of SERVICES) if (re.test(text)) return { label: label ?? text.replace(/^Amazon\s+/i, 'Amazon '), type, vendor: 'aws' };
  return { label: text, type: null, vendor: /\b(AWS|Amazon)\b/i.test(text) ? 'aws' : 'other' };
}

const isCap = (o) => o && typeof o === 'object' && !Array.isArray(o) && ('capability_name' in o || 'include' in o);
const category = (key, arr) => ({
  key, title: humanize(key),
  items: arr.flatMap((cap) => (Array.isArray(cap.include) ? cap.include : []).map((raw) => ({ capability: cap.capability_name ?? '', raw: String(raw), ...classifyService(raw) }))),
}) ;

export function parseStack(doc) {
  const s = doc?.stack;
  if (!s || typeof s !== 'object') return null;
  const meta = { pattern: s.pattern_id ?? null, version: s.version ?? null, region: s.region_pair ?? s.region ?? null, csp: s.csp ?? null };
  const groups = [];
  for (const [gk, gv] of Object.entries(s)) {
    if (!gv || typeof gv !== 'object') continue;                                   // pattern_id, version, ... are metadata
    const tiers = [];
    if (gk === 'custom_stack') {
      const items = (gv.include ?? []).map((raw) => ({ capability: 'Custom', raw: String(raw), ...classifyService(raw) }));
      if (items.length) tiers.push({ key: '', title: '', categories: [{ key: 'custom', title: 'Custom', items }] });
    } else {
      const direct = [];
      for (const [k, v] of Object.entries(gv)) {
        if (Array.isArray(v) && v.every(isCap)) direct.push(category(k, v));
        else if (v && typeof v === 'object') {
          const cats = Object.entries(v).filter(([, a]) => Array.isArray(a) && a.every(isCap)).map(([ck, a]) => category(ck, a));
          if (cats.length) tiers.push({ key: k, title: humanize(k), categories: cats });
        }
      }
      if (direct.length) tiers.unshift({ key: '', title: '', categories: direct });
    }
    const real = tiers.filter((t) => t.categories.some((c) => c.items.length));
    if (real.length) groups.push({ key: gk, title: humanize(gk), tiers: real });
  }
  return groups.length ? { meta, groups } : null;
}

// text of a stack.json -> model, or null when it is not one
export function stackFromText(text) {
  try { return parseStack(JSON.parse(text)); } catch { return null; }
}

export const stackCounts = (model) => {
  const items = model.groups.flatMap((g) => g.tiers.flatMap((t) => t.categories.flatMap((c) => c.items)));
  return { services: items.length, aws: items.filter((i) => i.vendor === 'aws').length, other: items.filter((i) => i.vendor !== 'aws').map((i) => i.label) };
};
