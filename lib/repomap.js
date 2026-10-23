// Repo map: understands ANY code repository without an AI, from its file tree and file contents.
// It reads the README, manifests (package.json, pom.xml, go.mod ...), Docker / compose, CI pipelines, Kubernetes and Terraform
// files, groups the code into components, follows imports between them, and returns facts plus a diagram model.
// Everything it infers (not read from a file) is marked `inferred`.

const dirOf = (p) => p.slice(0, Math.max(p.lastIndexOf('/'), 0));
const baseOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const extOf = (p) => { const b = baseOf(p); const i = b.lastIndexOf('.'); return i > 0 ? b.slice(i + 1).toLowerCase() : ''; };
const uniq = (a) => [...new Set(a)];
const plural = (n, w) => `${n} ${w}${n === 1 ? '' : 's'}`;
const clipText = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);

const DOC_LANG = { md: 'Markdown', mdx: 'Markdown', markdown: 'Markdown', rst: 'reStructuredText', txt: 'Text', adoc: 'AsciiDoc', yml: 'YAML', yaml: 'YAML', json: 'JSON', toml: 'TOML', csv: 'CSV', xml: 'XML', ipynb: 'Jupyter Notebook' };
const LANG = {
  js: 'JavaScript', jsx: 'JavaScript', mjs: 'JavaScript', cjs: 'JavaScript', ts: 'TypeScript', tsx: 'TypeScript', mts: 'TypeScript',
  py: 'Python', java: 'Java', kt: 'Kotlin', kts: 'Kotlin', go: 'Go', rs: 'Rust', rb: 'Ruby', php: 'PHP', cs: 'C#', swift: 'Swift',
  scala: 'Scala', dart: 'Dart', ex: 'Elixir', exs: 'Elixir', c: 'C', h: 'C', cpp: 'C++', cc: 'C++', cxx: 'C++', hpp: 'C++',
  vue: 'Vue', svelte: 'Svelte', sh: 'Shell', bash: 'Shell', ps1: 'PowerShell', sql: 'SQL', html: 'HTML', css: 'CSS', scss: 'CSS',
  sass: 'CSS', less: 'CSS', lua: 'Lua', r: 'R', groovy: 'Groovy', tf: 'Terraform', m: 'Objective-C', pl: 'Perl', jl: 'Julia',
};
const SOURCE = new Set(['JavaScript', 'TypeScript', 'Python', 'Java', 'Kotlin', 'Go', 'Rust', 'Ruby', 'PHP', 'C#', 'Swift', 'Scala', 'Dart', 'Elixir', 'C', 'C++', 'Vue', 'Svelte', 'Lua', 'R', 'Groovy', 'Objective-C', 'Perl', 'Julia']);
const IMPORT_LANGS = new Set(['JavaScript', 'TypeScript', 'Vue', 'Svelte', 'Python', 'Go', 'Java', 'Kotlin']);

// dependency name -> technology. `node` makes it an external box in the diagram.
const TECH = [
  [/^react(-dom)?$/, 'React', 'Frontend'], [/^next$/, 'Next.js', 'Frontend'], [/^vue$/, 'Vue', 'Frontend'], [/^@angular\/core$/, 'Angular', 'Frontend'],
  [/^svelte$/, 'Svelte', 'Frontend'], [/^solid-js$/, 'Solid', 'Frontend'], [/^react-native$|^expo$/, 'React Native', 'Mobile'], [/^flutter$/, 'Flutter', 'Mobile'],
  [/^vite$/, 'Vite', 'Build'], [/^webpack$/, 'Webpack', 'Build'], [/^esbuild$|^rollup$|^parcel$/, 'Bundler', 'Build'], [/^typescript$/, 'TypeScript', 'Build'],
  [/^express$/, 'Express', 'Backend'], [/^fastify$/, 'Fastify', 'Backend'], [/^@nestjs\/core$/, 'NestJS', 'Backend'], [/^koa$/, 'Koa', 'Backend'], [/^hono$/, 'Hono', 'Backend'],
  [/^flask$/, 'Flask', 'Backend'], [/^django$/, 'Django', 'Backend'], [/^fastapi$/, 'FastAPI', 'Backend'], [/^tornado$|^aiohttp$/, 'Python web server', 'Backend'],
  [/^org\.springframework\.boot|^spring-boot/, 'Spring Boot', 'Backend'], [/gin-gonic\/gin/, 'Gin', 'Backend'], [/labstack\/echo|gofiber\/fiber|go-chi\/chi/, 'Go web framework', 'Backend'],
  [/^actix-web$|^axum$|^rocket$/, 'Rust web framework', 'Backend'], [/^rails$/, 'Rails', 'Backend'], [/^sinatra$/, 'Sinatra', 'Backend'], [/^laravel\/framework$/, 'Laravel', 'Backend'],
  [/^microsoft\.aspnetcore/, 'ASP.NET Core', 'Backend'], [/^phoenix$/, 'Phoenix', 'Backend'],
  [/^pg$|^postgres$|^psycopg2?(-binary)?$|^asyncpg$|lib\/pq|jackc\/pgx|^org\.postgresql|^npgsql/, 'PostgreSQL', 'Database', 'Database'],
  [/^mysql2?$|^pymysql$|^mysqlclient$|^mariadb$|go-sql-driver\/mysql|^mysql-connector/, 'MySQL', 'Database', 'Database'],
  [/^mongodb$|^mongoose$|^pymongo$|^motor$|mongo-driver/, 'MongoDB', 'Database', 'Database'],
  [/^redis$|^ioredis$|^aioredis$|go-redis|^jedis$|^lettuce|^stackexchange\.redis/, 'Redis', 'Cache', 'Cache'], [/^memcached?$|^pymemcache$/, 'Memcached', 'Cache', 'Cache'],
  [/^sqlite3?$|^better-sqlite3$|^aiosqlite$|mattn\/go-sqlite3/, 'SQLite', 'Database'], [/^@aws-sdk\/client-dynamodb$|^dynamodb/, 'DynamoDB', 'Database', 'Database'],
  [/^@elastic\/elasticsearch$|^elasticsearch$|^opensearch/, 'Elasticsearch / OpenSearch', 'Search', 'Search'], [/^cassandra-driver$/, 'Cassandra', 'Database', 'Database'],
  [/^neo4j/, 'Neo4j', 'Database', 'Database'],
  [/^prisma$|^@prisma\/client$/, 'Prisma', 'Data access'], [/^typeorm$/, 'TypeORM', 'Data access'], [/^sequelize$/, 'Sequelize', 'Data access'], [/^drizzle-orm$/, 'Drizzle', 'Data access'],
  [/^sqlalchemy$/, 'SQLAlchemy', 'Data access'], [/gorm\.io/, 'GORM', 'Data access'], [/hibernate|^spring-data|^org\.springframework\.boot:spring-boot-starter-data/, 'JPA / Hibernate', 'Data access'], [/^knex$/, 'Knex', 'Data access'],
  [/^kafkajs$|^kafka-python$|^confluent-kafka$|sarama|^org\.apache\.kafka|^spring-kafka/, 'Kafka', 'Message queue', 'Message queue'],
  [/^amqplib$|^pika$|^amqp$|rabbitmq|^spring-rabbit/, 'RabbitMQ', 'Message queue', 'Message queue'], [/^bullmq?$/, 'BullMQ', 'Message queue'], [/^celery$/, 'Celery', 'Message queue'],
  [/^nats$|nats\.go/, 'NATS', 'Message queue', 'Message queue'],
  [/^aws-sdk$|^@aws-sdk\/|^boto3$|^botocore$|^software\.amazon\.awssdk|aws-sdk-go/, 'AWS SDK', 'Cloud', 'Cloud services'],
  [/^@azure\/|^azure-|^com\.azure/, 'Azure SDK', 'Cloud', 'Cloud services'], [/^@google-cloud\/|^google-cloud-|cloud\.google\.com\/go/, 'Google Cloud SDK', 'Cloud', 'Cloud services'],
  [/^firebase(-admin)?$|^@firebase\//, 'Firebase', 'Cloud', 'Cloud services'], [/^@supabase\/|^supabase$/, 'Supabase', 'Cloud', 'Cloud services'],
  [/^passport|^next-auth$|^@auth0\/|^auth0$|^keycloak|^@okta\/|^oauthlib$|^authlib$|spring-security/, 'Authentication', 'Auth', 'Auth provider'],
  [/^jsonwebtoken$|^pyjwt$|^jose$/, 'JWT', 'Auth'],
  [/^stripe$|^@stripe\//, 'Stripe', 'Payments', 'Payments'], [/^paypal/, 'PayPal', 'Payments', 'Payments'],
  [/^openai$|^@anthropic-ai\/sdk$|^anthropic$|^@google\/generative-ai$|^google-generativeai$|^cohere/, 'LLM API', 'AI', 'AI API'],
  [/^langchain|^llama-index|^llamaindex|^transformers$|^torch$|^tensorflow$|^scikit-learn$|^sklearn$|^keras$|^xgboost$/, 'ML / AI libraries', 'AI'],
  [/^@sentry\/|^sentry-sdk$|^dd-trace|^ddtrace$|^newrelic$|^prom-client$|^prometheus-client$|^@opentelemetry\//, 'Monitoring', 'Monitoring', 'Monitoring'],
  [/^nodemailer$|^@sendgrid\/|^sendgrid$|^mailgun|^twilio$|^smtplib$/, 'Email / SMS', 'Messaging', 'Email / SMS'],
  [/^graphql$|^apollo|^@apollo\/|^graphene$|^gqlgen/, 'GraphQL', 'API'], [/^@grpc\/|^grpcio$|^google\.golang\.org\/grpc|^io\.grpc/, 'gRPC', 'API'],
  [/^swagger|^openapi|^@trpc\//, 'API schema', 'API'], [/^socket\.io|^ws$|^websockets$|^gorilla\/websocket/, 'WebSockets', 'API'],
  [/^jest$|^mocha$|^vitest$|^pytest|^junit|^cypress$|^playwright|^@playwright\/test$|^testing-library|^rspec/, 'Tests', 'Testing'],
];

// environment variable names -> external service hints
const ENV_HINTS = [
  [/DATABASE|DB_|POSTGRES|PG(HOST|USER)|MYSQL|MONGO|SQLITE/i, 'Database'], [/REDIS|MEMCACHE|CACHE_/i, 'Cache'], [/KAFKA|RABBIT|AMQP|SQS|QUEUE|NATS|PUBSUB/i, 'Message queue'],
  [/S3_|BUCKET|BLOB|STORAGE_/i, 'Object storage'], [/STRIPE|PAYPAL|RAZORPAY/i, 'Payments'], [/OPENAI|ANTHROPIC|GEMINI|LLM_|COHERE/i, 'AI API'],
  [/SENTRY|DATADOG|NEWRELIC|OTEL_/i, 'Monitoring'], [/AUTH0|OKTA|COGNITO|KEYCLOAK|OAUTH|JWT|CLIENT_SECRET/i, 'Auth provider'], [/SMTP|SENDGRID|MAILGUN|TWILIO|EMAIL_/i, 'Email / SMS'],
  [/^AWS_|^AZURE_|^GCP_|^GOOGLE_/i, 'Cloud services'], [/ELASTIC|OPENSEARCH|ALGOLIA/i, 'Search'],
];
const IMAGE_NODE = [
  [/postgres|timescale|cockroach/i, 'PostgreSQL', 'Database'], [/mysql|mariadb/i, 'MySQL', 'Database'], [/mongo/i, 'MongoDB', 'Database'], [/redis|valkey/i, 'Redis', 'Cache'], [/memcached/i, 'Memcached', 'Cache'],
  [/rabbitmq/i, 'RabbitMQ', 'Message queue'], [/kafka|redpanda/i, 'Kafka', 'Message queue'], [/zookeeper/i, 'ZooKeeper', 'Message queue'], [/nats/i, 'NATS', 'Message queue'],
  [/elasticsearch|opensearch/i, 'Elasticsearch / OpenSearch', 'Search'], [/minio|localstack|azurite/i, 'Object storage (local)', 'Object storage'], [/mailhog|mailpit|maildev/i, 'Mail catcher', 'Email / SMS'],
  [/keycloak/i, 'Keycloak', 'Auth provider'], [/nginx|traefik|caddy|haproxy|envoy/i, 'Reverse proxy', 'Proxy'], [/prometheus|grafana|jaeger|loki/i, 'Monitoring stack', 'Monitoring'],
];

const KIND_BY_NAME = [
  [/^(tests?|__tests__|spec|specs|e2e|cypress|integration[-_]?tests?|testing)$/i, 'tests'], [/^(docs?|documentation|wiki|website|site)$/i, 'docs'],
  [/^(client|frontend|front-end|web|webapp|ui|app|apps?\/web|pages|views?|components?|public|static|assets|styles?|www|dashboard|portal)$/i, 'frontend'],
  [/^(server|backend|back-end|api|apis|routes?|controllers?|handlers?|services?|middlewares?|resolvers?|endpoints?|cmd|worker|workers|jobs?|cron|functions?|lambda|lambdas)$/i, 'backend'],
  [/^(models?|entities|db|database|migrations?|repositories|repository|dao|schemas?|prisma|orm|store|stores)$/i, 'data'],
  [/^(lib|libs|libraries|utils?|helpers?|common|shared|core|internal|pkg|packages?|domain|sdk|modules?|types|constants?)$/i, 'library'],
  [/^(scripts?|tools?|bin|tooling|build|ci|hack|dev|devtools|generators?)$/i, 'tooling'], [/^(config|configs|conf|settings|env)$/i, 'config'],
  [/^(infra|infrastructure|terraform|deploy|deployment|k8s|kubernetes|helm|charts?|ops|docker|\.github|\.azure|\.circleci)$/i, 'infra'],
  [/^(android|ios|mobile|flutter)$/i, 'mobile'],
];

// ---------------------------------------------------------------- small parsers
const ENT = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&apos;': "'", '&nbsp;': ' ' };
const plainText = (t) => String(t).replace(/<!--[\s\S]*?-->/g, ' ').replace(/<[^>]+>/g, ' ').replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (m) => ENT[m]).replace(/\s+/g, ' ').trim();


// A README that is mostly a catalog (awesome lists, "build your own x", learning paths): sections with the links they list
const CATALOG_SKIP = /^(contents?|table of contents|toc|contribut\w*|licen[sc]e|origins?|credits?|sponsors?|backers?|footnotes?|about|related|see also|thanks|acknowledg\w*|star history|support)\b/i;
function parseCatalog(text) {
  const sections = []; let h2 = ''; let cur = null; let inCode = false;
  const hosts = new Map();
  for (const raw of String(text).replace(/\r/g, '').split('\n')) {
    if (/^\s*```/.test(raw)) { inCode = !inCode; continue; }
    if (inCode) continue;
    const h = /^(#{2,4})\s+(.+?)\s*#*\s*$/.exec(raw);
    if (h) {
      const title = plainText(h[2].replace(/\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[`*_]/g, '').replace(/^Build your own\s+/i, '')).trim();
      if (h[1].length === 2) h2 = title;
      cur = { title, level: h[1].length, parent: h[1].length === 2 ? '' : h2, items: [] };
      sections.push(cur);
      continue;
    }
    const li = /^\s*(?:[-*+]|\d+\.)\s+(.*)$/.exec(raw);
    if (li && cur) {
      const link = /\[([^\]]+)\]\((https?:\/\/[^)\s]+)/.exec(li[1]) || /<a [^>]*href="(https?:\/\/[^"]+)"[^>]*>([^<]+)/.exec(li[1]);
      if (!link) continue;
      const [text, url] = /^\[/.test(link[0]) ? [link[1], link[2]] : [link[2], link[1]];
      let host = ''; try { host = new URL(url).hostname.replace(/^www\./, ''); } catch { /* ignore */ }
      cur.items.push({ text: clipText(plainText(text.replace(/[`*_]/g, '')), 90), url, host });
      if (host) hosts.set(host, (hosts.get(host) ?? 0) + 1);
    }
  }
  const real = sections.filter((x) => x.items.length && !CATALOG_SKIP.test(x.title));
  // a heading that only groups others (an H2 with H3 children) is a group, not an entry
  const parents = new Set(real.filter((x) => x.parent).map((x) => x.parent));
  const entries = real.filter((x) => !(x.level === 2 && parents.has(x.title) && x.items.length < 3));
  return {
    sections: entries.slice(0, 80).map((x) => ({ title: x.title, parent: x.parent, count: x.items.length, sample: x.items.slice(0, 5).map((i) => ({ text: i.text, url: i.url })) })),
    links: entries.reduce((n, x) => n + x.items.length, 0),
    hosts: [...hosts].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([host, n]) => ({ host, n })),
  };
}

function parseReadme(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const headings = [];
  let title = '';
  for (const l of lines) {
    const m = /^(#{1,3})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) { headings.push({ level: m[1].length, text: m[2].replace(/&(?:amp|lt|gt|quot|#39|apos|nbsp);/g, (x) => ENT[x]).replace(/[`*_[\]()]/g, '').trim() }); if (!title && m[1].length === 1) title = m[2].replace(/[`*_]/g, '').trim(); }
  }
  // intro: first real paragraphs (no badges, images, html, headings, tables, code)
  const paras = []; let cur = []; let inCode = false;
  for (const l of lines) {
    if (/^\s*```/.test(l)) { inCode = !inCode; continue; }
    if (inCode) continue;
    if (!l.trim()) { if (cur.length) { paras.push(cur.join(' ')); cur = []; } continue; }
    if (/^\s*(#|\||!\[|\[!\[|<|---|===|>)/.test(l) || /^\s*(\[!\[|!\[)/.test(l)) { if (cur.length) { paras.push(cur.join(' ')); cur = []; } continue; }
    cur.push(l.trim());
  }
  if (cur.length) paras.push(cur.join(' '));
  const clean = paras.map((p) => plainText(p.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1').replace(/[*_`]/g, ''))).filter((p) => p.length > 25);
  const intro = clipText(clean.slice(0, 2).join('\n\n'), 900);
  // commands under install / usage style headings
  const run = [];
  let section = ''; inCode = false; let block = [];
  for (const l of lines) {
    const h = /^#{1,4}\s+(.+)/.exec(l);
    if (!inCode && h) { section = h[1]; continue; }
    if (/^\s*```/.test(l)) {
      if (!inCode) { inCode = true; block = []; } else {
        inCode = false;
        if (/install|setup|set up|getting started|quick ?start|usage|run|running|build|develop|how to|start|deploy/i.test(section) && block.length && run.length < 3) run.push({ section, lines: block.slice(0, 8) });
      }
      continue;
    }
    if (inCode) block.push(l);
  }
  return { title, intro, headings: headings.slice(0, 40), run };
}

function parseJson(text) { try { return JSON.parse(text); } catch { return null; } }

function parseManifest(path, text) {
  const file = baseOf(path); const dir = dirOf(path);
  const out = { path, dir, file, kind: '', name: '', description: '', deps: [], devDeps: [], scripts: {}, main: '', bin: [], workspaces: [], module: '' };
  if (file === 'package.json') {
    const j = parseJson(text); if (!j) return null;
    out.kind = 'npm'; out.name = j.name ?? ''; out.description = j.description ?? ''; out.scripts = j.scripts ?? {}; out.main = j.main ?? j.module ?? '';
    out.deps = Object.keys(j.dependencies ?? {}); out.devDeps = Object.keys(j.devDependencies ?? {});
    out.bin = typeof j.bin === 'string' ? [j.bin] : Object.values(j.bin ?? {});
    out.workspaces = Array.isArray(j.workspaces) ? j.workspaces : (j.workspaces?.packages ?? []);
  } else if (file === 'requirements.txt') {
    out.kind = 'pip'; out.deps = text.split('\n').map((l) => l.replace(/#.*/, '').trim()).filter((l) => l && !l.startsWith('-')).map((l) => l.split(/[=<>!~;[ ]/)[0].toLowerCase());
  } else if (file === 'pyproject.toml') {
    out.kind = 'python'; out.name = /^\s*name\s*=\s*["']([^"']+)/m.exec(text)?.[1] ?? '';
    const arr = /dependencies\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '';
    out.deps = [...arr.matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1].toLowerCase());
    const poetry = /\[tool\.poetry\.dependencies\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? '';
    out.deps.push(...[...poetry.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1].toLowerCase()).filter((d) => d !== 'python'));
  } else if (file === 'Pipfile') {
    out.kind = 'pip'; const pk = /\[packages\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? ''; out.deps = [...pk.matchAll(/^\s*([A-Za-z0-9_.-]+)\s*=/gm)].map((m) => m[1].toLowerCase());
  } else if (file === 'setup.py') {
    out.kind = 'python'; out.name = /name\s*=\s*["']([^"']+)/.exec(text)?.[1] ?? '';
    out.deps = [...(/install_requires\s*=\s*\[([\s\S]*?)\]/.exec(text)?.[1] ?? '').matchAll(/["']([A-Za-z0-9_.-]+)/g)].map((m) => m[1].toLowerCase());
  } else if (file === 'pom.xml') {
    out.kind = 'maven'; out.name = /<artifactId>([^<]+)<\/artifactId>/.exec(text.replace(/<parent>[\s\S]*?<\/parent>/, ''))?.[1] ?? '';
    out.deps = [...text.matchAll(/<dependency>[\s\S]*?<groupId>([^<]+)<\/groupId>[\s\S]*?<artifactId>([^<]+)<\/artifactId>/g)].map((m) => `${m[1]}:${m[2]}`.toLowerCase());
    out.modules = [...text.matchAll(/<module>([^<]+)<\/module>/g)].map((m) => m[1]);
    if (/spring-boot/i.test(text)) out.deps.push('org.springframework.boot:spring-boot');
  } else if (/^build\.gradle(\.kts)?$/.test(file)) {
    out.kind = 'gradle'; out.deps = [...text.matchAll(/(?:implementation|api|compile|runtimeOnly|testImplementation)\s*\(?\s*["']([^"':]+:[^"':]+)/g)].map((m) => m[1].toLowerCase());
    if (/org\.springframework\.boot/.test(text)) out.deps.push('org.springframework.boot:spring-boot');
  } else if (file === 'go.mod') {
    out.kind = 'go'; out.name = /^module\s+(\S+)/m.exec(text)?.[1] ?? '';
    out.deps = [...text.matchAll(/^\s*(?:require\s+)?([a-z0-9.-]+\.[a-z]+\/[^\s]+)\s+v[\w.+-]+/gm)].map((m) => m[1].toLowerCase());
  } else if (file === 'Cargo.toml') {
    out.kind = 'cargo'; out.name = /^\s*name\s*=\s*"([^"]+)"/m.exec(text)?.[1] ?? '';
    const d = /\[dependencies\]([\s\S]*?)(\n\[|$)/.exec(text)?.[1] ?? ''; out.deps = [...d.matchAll(/^\s*([A-Za-z0-9_-]+)\s*=/gm)].map((m) => m[1].toLowerCase());
  } else if (file === 'Gemfile') {
    out.kind = 'bundler'; out.deps = [...text.matchAll(/^\s*gem\s+["']([^"']+)/gm)].map((m) => m[1].toLowerCase());
  } else if (file === 'composer.json') {
    const j = parseJson(text); if (!j) return null;
    out.kind = 'composer'; out.name = j.name ?? ''; out.description = j.description ?? ''; out.deps = Object.keys(j.require ?? {}).map((d) => d.toLowerCase());
  } else if (/\.csproj$/.test(file)) {
    out.kind = 'dotnet'; out.name = file.replace(/\.csproj$/, ''); out.deps = [...text.matchAll(/<PackageReference\s+Include="([^"]+)"/g)].map((m) => m[1].toLowerCase());
    if (/Microsoft\.NET\.Sdk\.Web/.test(text)) out.deps.push('microsoft.aspnetcore');
  } else if (file === 'pubspec.yaml') {
    out.kind = 'dart'; out.name = /^name:\s*(\S+)/m.exec(text)?.[1] ?? ''; out.deps = [...text.matchAll(/^ {2}([a-z0-9_]+):/gm)].map((m) => m[1]);
    if (/^\s*flutter:/m.test(text)) out.deps.push('flutter');
  } else return null;
  return out;
}
const MANIFEST = /(^|\/)(package\.json|requirements\.txt|pyproject\.toml|Pipfile|setup\.py|pom\.xml|build\.gradle(\.kts)?|go\.mod|Cargo\.toml|Gemfile|composer\.json|pubspec\.yaml|[^/]+\.csproj)$/;

// a small indentation-based reader for docker-compose files (services, image/build, ports, depends_on)
function parseCompose(text) {
  const lines = text.replace(/\r/g, '').split('\n');
  const start = lines.findIndex((l) => /^services:\s*$/.test(l));
  if (start < 0) return [];
  const services = []; let cur = null; let key = ''; let keyIndent = 0;
  for (let i = start + 1; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim() || /^\s*#/.test(l)) continue;
    const indent = l.match(/^ */)[0].length;
    if (indent === 0) break;                                                        // next top-level key (volumes:, networks:)
    const t = l.trim();
    if (indent <= 2 && /^[\w.-]+:\s*$/.test(t)) { cur = { name: t.replace(':', ''), image: '', build: '', ports: [], dependsOn: [], env: [] }; services.push(cur); key = ''; continue; }
    if (!cur) continue;
    const kv = /^([\w-]+):\s*(.*)$/.exec(t);
    if (indent <= 4 && kv) {
      key = kv[1]; keyIndent = indent; const v = kv[2].replace(/^["']|["']$/g, '');
      if (key === 'image') cur.image = v; else if (key === 'build') cur.build = v || '.';
      else if (key === 'depends_on' && v.startsWith('[')) cur.dependsOn.push(...v.replace(/[[\]'" ]/g, '').split(',').filter(Boolean));
      else if (key === 'ports' && v.startsWith('[')) cur.ports.push(...v.replace(/[[\]'" ]/g, '').split(',').filter(Boolean));
      continue;
    }
    if (indent > keyIndent) {
      if (key === 'build') { const c = /^context:\s*(.+)$/.exec(t); if (c) cur.build = c[1].replace(/["']/g, ''); }
      else if (key === 'ports' && t.startsWith('-')) cur.ports.push(t.slice(1).trim().replace(/["']/g, ''));
      else if (key === 'depends_on') { const d = t.startsWith('-') ? t.slice(1).trim() : /^([\w.-]+):/.exec(t)?.[1]; if (d && !/^(condition|required)$/.test(d)) cur.dependsOn.push(d.replace(/["']/g, '')); }
      else if (key === 'environment') { const e = /^-?\s*([A-Z_][A-Z0-9_]*)\s*[=:]/.exec(t); if (e) cur.env.push(e[1]); }
    }
  }
  return services;
}

function parseWorkflow(path, text) {
  const name = /^name:\s*(.+)$/m.exec(text)?.[1]?.replace(/["']/g, '') ?? baseOf(path);
  const jobsAt = text.search(/^jobs:\s*$/m);
  const jobs = jobsAt < 0 ? [] : [...text.slice(jobsAt).matchAll(/^ {2}([\w.-]+):\s*$/gm)].map((m) => m[1]);
  const uses = uniq([...text.matchAll(/uses:\s*([\w./-]+)@/g)].map((m) => m[1]));
  const triggers = /^on:\s*(.*)$/m.exec(text)?.[1] ?? '';
  const deploy = /deploy|release|publish|docker\s+push|terraform\s+apply|kubectl|helm\s+(upgrade|install)|aws-actions|azure\/|google-github-actions|wrangler|vercel|netlify/i.test(text);
  return { file: path, name, jobs, uses, deploy, triggers: clipText(triggers, 60) };
}

const importsOf = (lang, text) => {
  const out = [];
  if (lang === 'JavaScript' || lang === 'TypeScript' || lang === 'Vue' || lang === 'Svelte') {
    for (const re of [/(?:import|export)\s+(?:[^'";]*?\s+from\s+)?['"]([^'"]+)['"]/g, /require\(\s*['"]([^'"]+)['"]\s*\)/g, /import\(\s*['"]([^'"]+)['"]\s*\)/g]) for (const m of text.matchAll(re)) out.push(m[1]);
  } else if (lang === 'Python') {
    for (const m of text.matchAll(/^[ \t]*from[ \t]+(\.*[\w.]*)[ \t]+import[ \t]+([\w*, \t()]+)/gm)) out.push(m[1] === '.' || /^\.+$/.test(m[1]) ? `${m[1]}${m[2].split(',')[0].replace(/[()\s]/g, '')}` : m[1]);
    for (const m of text.matchAll(/^[ \t]*import[ \t]+([\w., \t]+)/gm)) for (const part of m[1].split(',')) out.push(part.trim().split(/\s+as\s+/)[0]);
  } else if (lang === 'Go') {
    for (const block of text.matchAll(/import\s*\(([\s\S]*?)\)/g)) for (const m of block[1].matchAll(/"([^"]+)"/g)) out.push(m[1]);
    for (const m of text.matchAll(/^\s*import\s+(?:\w+\s+)?"([^"]+)"/gm)) out.push(m[1]);
  } else if (lang === 'Java' || lang === 'Kotlin') {
    for (const m of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.]+?)(?:\.\*)?\s*;?\s*$/gm)) out.push(m[1]);
  }
  return out;
};

function joinPath(base, rel) {
  const parts = base ? base.split('/') : [];
  for (const seg of rel.split('/')) { if (seg === '' || seg === '.') continue; if (seg === '..') parts.pop(); else parts.push(seg); }
  return parts.join('/');
}

// ---------------------------------------------------------------- the analysis
export function analyzeRepo({ name = '', tree, files }) {
  const byPath = new Map(files.map((f) => [f.path, f.content]));
  const allPaths = tree.map((t) => t.path);
  const pathSet = new Set(allPaths);
  const notes = [];

  // languages by bytes of source code
  const bytes = new Map();
  for (const t of tree) { const l = LANG[extOf(t.path)]; if (l && SOURCE.has(l)) bytes.set(l, (bytes.get(l) ?? 0) + (t.size || 0)); }
  const totalBytes = [...bytes.values()].reduce((a, b) => a + b, 0) || 1;
  let languages = [...bytes].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([n, b]) => ({ name: n, bytes: b, percent: Math.round((b / totalBytes) * 1000) / 10 }));
  const docBytes = new Map();
  for (const t of tree) { const l = DOC_LANG[extOf(t.path)]; if (l) docBytes.set(l, (docBytes.get(l) ?? 0) + (t.size || 0)); }
  const docFiles = tree.filter((t) => ['Markdown', 'reStructuredText', 'Text', 'AsciiDoc'].includes(DOC_LANG[extOf(t.path)])).length;
  const contentRepo = bytes.size === 0 || (languages.length && tree.filter((t) => LANG[extOf(t.path)] && SOURCE.has(LANG[extOf(t.path)])).length < 3 && docFiles >= 3);
  if (!languages.length) { const tot = [...docBytes.values()].reduce((a, b) => a + b, 0) || 1; languages = [...docBytes].sort((a, b) => b[1] - a[1]).slice(0, 6).map(([n, b]) => ({ name: n, bytes: b, percent: Math.round((b / tot) * 1000) / 10 })); }

  // readme
  const readmePath = allPaths.filter((p) => /^readme(\.(md|markdown|rst|txt))?$/i.test(baseOf(p))).sort((a, b) => a.split('/').length - b.split('/').length)[0];
  const readme = readmePath && byPath.has(readmePath) ? { path: readmePath, ...parseReadme(byPath.get(readmePath)) } : { path: '', title: '', intro: '', headings: [], run: [] };

  // manifests
  const manifests = [];
  for (const [p, text] of byPath) if (MANIFEST.test(p) && !/(^|\/)(test|tests|fixtures?|examples?|samples?|node_modules)\//i.test(p)) { const m = parseManifest(p, text); if (m) manifests.push(m); }
  manifests.sort((a, b) => a.dir.split('/').length - b.dir.split('/').length);
  const rootManifest = manifests.find((m) => m.dir === '');

  // technologies, per manifest
  const techsOf = (m) => {
    const found = [];
    for (const d of uniq([...m.deps, ...m.devDeps])) for (const [re, label, cat, node] of TECH) if (re.test(d)) { found.push({ label, cat, node, dep: d, dev: !m.deps.includes(d) }); break; }
    return found;
  };
  const techByManifest = new Map(manifests.map((m) => [m, techsOf(m)]));
  const techAll = new Map();
  for (const [m, list] of techByManifest) for (const t of list) { const k = t.label; if (!techAll.has(k)) techAll.set(k, { label: t.label, cat: t.cat, node: t.node, evidence: [], dev: t.dev }); const e = techAll.get(k); if (e.evidence.length < 3) e.evidence.push(`${t.dep} in ${m.path}`); if (!t.dev) e.dev = false; }

  // docker, compose, CI, k8s, terraform, openapi, env
  const dockerfiles = allPaths.filter((p) => /(^|\/)(Dockerfile(\.[\w.-]+)?|[\w.-]+\.Dockerfile)$/.test(p) && byPath.has(p)).map((p) => {
    const t = byPath.get(p);
    const from = [...t.matchAll(/^FROM\s+(?:--platform=\S+\s+)?(\S+)/gim)].map((m) => m[1]).pop() ?? '';
    return { path: p, dir: dirOf(p), from, expose: uniq([...t.matchAll(/^EXPOSE\s+(.+)$/gim)].flatMap((m) => m[1].split(/\s+/))), cmd: (/^(?:CMD|ENTRYPOINT)\s+(.+)$/im.exec(t)?.[1] ?? '').slice(0, 80) };
  });
  const composeFiles = allPaths.filter((p) => /(^|\/)(docker-)?compose(\.[\w-]+)?\.ya?ml$/.test(p) && byPath.has(p));
  const compose = composeFiles.flatMap((p) => parseCompose(byPath.get(p)).map((s) => ({ ...s, file: p })));
  const workflows = allPaths.filter((p) => /^\.github\/workflows\/[^/]+\.ya?ml$/.test(p) && byPath.has(p)).map((p) => parseWorkflow(p, byPath.get(p)));
  const otherCi = [];
  if (pathSet.has('azure-pipelines.yml') || allPaths.some((p) => /(^|\/)azure-pipelines[\w.-]*\.ya?ml$/.test(p))) otherCi.push({ system: 'Azure Pipelines', detail: uniq([...(byPath.get('azure-pipelines.yml') ?? '').matchAll(/^\s*-\s*(?:stage|job):\s*(\S+)/gm)].map((m) => m[1])).slice(0, 8) });
  if (pathSet.has('.gitlab-ci.yml')) otherCi.push({ system: 'GitLab CI', detail: (/^stages:\s*\n((?:\s+-\s*\S+\n?)+)/m.exec(byPath.get('.gitlab-ci.yml') ?? '')?.[1] ?? '').split('\n').map((l) => l.replace(/^\s*-\s*/, '').trim()).filter(Boolean).slice(0, 8) });
  if (allPaths.some((p) => /(^|\/)Jenkinsfile$/.test(p))) otherCi.push({ system: 'Jenkins', detail: uniq([...(byPath.get('Jenkinsfile') ?? '').matchAll(/stage\(\s*['"]([^'"]+)/g)].map((m) => m[1])).slice(0, 8) });
  if (pathSet.has('.circleci/config.yml')) otherCi.push({ system: 'CircleCI', detail: [] });
  const k8sFiles = allPaths.filter((p) => /\.ya?ml$/.test(p) && byPath.has(p) && /^\s*apiVersion:/m.test(byPath.get(p)) && /^\s*kind:\s*(Deployment|StatefulSet|DaemonSet|Service|Ingress|CronJob|Job|ConfigMap)\b/m.test(byPath.get(p)) && !/\.github\//.test(p));
  const k8sKinds = {};
  for (const p of k8sFiles) for (const m of byPath.get(p).matchAll(/^\s*kind:\s*(\w+)/gm)) k8sKinds[m[1]] = (k8sKinds[m[1]] ?? 0) + 1;
  const helm = allPaths.filter((p) => /(^|\/)Chart\.yaml$/.test(p));
  const tfFiles = allPaths.filter((p) => p.endsWith('.tf'));
  const tfResources = tfFiles.reduce((n, p) => n + [...(byPath.get(p) ?? '').matchAll(/^\s*resource\s+"/gm)].length, 0);
  const openapi = allPaths.filter((p) => /(^|\/)(openapi|swagger)[\w.-]*\.(ya?ml|json)$/i.test(p) && byPath.has(p)).map((p) => {
    const t = byPath.get(p); const j = p.endsWith('.json') ? parseJson(t) : null;
    const paths = j ? Object.keys(j.paths ?? {}).length : [...(/^paths:\s*\n([\s\S]*?)(\n\S|$)/m.exec(t)?.[1] ?? '').matchAll(/^ {2}\/\S*:/gm)].length;
    return { path: p, title: j?.info?.title ?? /^\s*title:\s*(.+)$/m.exec(t)?.[1]?.replace(/["']/g, '') ?? '', endpoints: paths };
  });
  const envFiles = allPaths.filter((p) => /(^|\/)(\.env\.(example|sample|template|dist)|example\.env|env\.example)$/.test(p) && byPath.has(p));
  const envVars = uniq(envFiles.flatMap((p) => [...byPath.get(p).matchAll(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]+)\s*=/gm)].map((m) => m[1])));

  // ------------------------------------------------------------ components
  const codeFiles = allPaths.filter((p) => { const l = LANG[extOf(p)]; return l && SOURCE.has(l); });
  const isRootWorkspace = rootManifest && (rootManifest.workspaces.length || rootManifest.modules?.length) && !techByManifest.get(rootManifest)?.some((t) => t.cat === 'Frontend' || t.cat === 'Backend');
  const compManifests = manifests.filter((m) => m.dir !== '' && !['requirements.txt'].includes(m.file) && !(m.file === 'pyproject.toml' && manifests.some((o) => o.dir === m.dir && o !== m && o.file === 'setup.py')));
  // one manifest per dir (prefer the richest)
  const perDir = new Map();
  for (const m of compManifests) { const cur = perDir.get(m.dir); if (!cur || (m.deps.length > cur.deps.length)) perDir.set(m.dir, m); }
  let comps = [];
  let singleProject = false;
  let contentMode = false;
  const mk = (path, nm, manifest) => ({ id: `c:${path || '.'}`, name: nm, path, kind: 'other', manifest, files: 0, languages: new Map(), techs: [], entry: '', depsOut: [] });
  if (contentRepo && perDir.size < 2) {
    // no source code: the top-level folders (and the root files) are the parts, made of documents and data
    const tops = uniq(allPaths.filter((p) => p.includes('/') && !p.startsWith('.')).map((p) => p.split('/')[0]));
    for (const d of tops) comps.push(mk(d, d, null));
    if (allPaths.some((p) => !p.includes('/') && !/^readme/i.test(p))) comps.push(mk('', '(root files)', null));
    contentMode = true;
  } else if (perDir.size >= 2 || (isRootWorkspace && perDir.size >= 1)) {
    for (const [dir, m] of perDir) comps.push(mk(dir, m.name ? m.name.replace(/^@[^/]+\//, '') : baseOf(dir), m));
  } else {
    // single project: the folders under src/ (descending through pass-through folders like src/main/java/com/acme), or the top-level source folders
    const topDirs = uniq(codeFiles.map((p) => p.split('/')[0]).filter((d) => d && codeFiles.some((f) => f.startsWith(`${d}/`))));
    const subsOf = (base) => uniq(codeFiles.filter((f) => (base ? f.startsWith(`${base}/`) : true) && f.slice(base ? base.length + 1 : 0).includes('/')).map((f) => f.slice(base ? base.length + 1 : 0).split('/')[0]));
    const directOf = (base) => codeFiles.filter((f) => dirOf(f) === base).length;
    const srcTop = ['src', 'app', 'lib'].find((d) => topDirs.includes(d));
    const bases = [];
    if (srcTop) {
      let base = srcTop;
      for (let guard = 0; guard < 8 && subsOf(base).length === 1 && directOf(base) === 0; guard++) base = `${base}/${subsOf(base)[0]}`;
      const subs = subsOf(base);
      if (subs.length + (directOf(base) ? 1 : 0) >= 2) {
        for (const sub of subs) bases.push(`${base}/${sub}`);
        if (directOf(base)) bases.push(base);
      } else bases.push(base);
      for (const d of topDirs) if (d !== srcTop) bases.push(d);
    } else {
      const CONTAINER = /^(internal|pkg|cmd|packages?|apps?|services?|modules?|libs?|plugins?|crates?|projects?|src)$/i;
      for (const d of topDirs) {
        const subs = subsOf(d);
        if (CONTAINER.test(d) && subs.length >= 2 && directOf(d) <= 1) { for (const sub of subs) bases.push(`${d}/${sub}`); if (directOf(d)) bases.push(d); } else bases.push(d);
      }
    }
    for (const b of bases) comps.push(mk(b, b === bases.find((x) => directOf(x) && x === b && b.includes('/')) && directOf(b) && subsOf(b).length ? `${baseOf(b)} (core)` : baseOf(b), rootManifest));
    if (codeFiles.some((f) => !f.includes('/'))) comps.push(mk('', '(root files)', rootManifest));
    if (!comps.length) comps.push(mk('', name || 'project', rootManifest));
    singleProject = true;
  }
  const MAXC = 14;
  const owner = (file) => {                                                       // the component a file belongs to: longest path prefix
    let best = null;
    for (const c of comps) if ((c.path === '' || file === c.path || file.startsWith(`${c.path}/`)) && (!best || c.path.length > best.path.length)) best = c;
    return best;
  };
  for (const f of (contentMode ? allPaths.filter((p) => !p.startsWith('.') || p.includes('/')) : codeFiles)) { const c = owner(f); if (c) { c.files++; const l = LANG[extOf(f)] ?? DOC_LANG[extOf(f)] ?? 'Other'; c.languages.set(l, (c.languages.get(l) ?? 0) + 1); } }
  // a "(root files)" component only when it has code; drop empty components
  comps = comps.filter((c) => c.files > 0);
  if (comps.length > MAXC) {
    comps.sort((a, b) => b.files - a.files);
    const keep = comps.slice(0, MAXC - 1); const rest = comps.slice(MAXC - 1);
    const other = mk('', `other (${rest.length} folders)`, null); other.files = rest.reduce((n, c) => n + c.files, 0); other.merged = rest.map((c) => c.path);
    comps = [...keep, other];
    notes.push(`${rest.length} small folders were grouped as "other".`);
  }
  const projCats = new Set((rootManifest ? techByManifest.get(rootManifest) ?? [] : []).filter((t) => !t.dev).map((t) => t.cat));
  for (const c of comps) {
    c.language = [...c.languages].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '';
    const m = c.manifest && c.manifest.dir === c.path ? c.manifest : null;
    c.techs = m ? (techByManifest.get(m) ?? []).filter((t) => !t.dev && t.cat !== 'Testing' && t.cat !== 'Build') : [];
    // kind: from technologies first, then from the folder name
    const cats = new Set(c.techs.map((t) => t.cat));
    const nm = baseOf(c.path) || c.name;
    const byName = KIND_BY_NAME.find(([re]) => re.test(nm) || re.test(c.path))?.[1];
    if (cats.has('Mobile')) c.kind = 'mobile';
    else if (cats.has('Frontend') && !cats.has('Backend')) c.kind = 'frontend';
    else if (cats.has('Backend') && !cats.has('Frontend')) c.kind = 'backend';
    else if (cats.has('Frontend') && cats.has('Backend')) c.kind = 'backend';
    else if (byName) c.kind = byName;
    else if (c.language === 'Vue' || c.language === 'Svelte' || (c.language === 'TypeScript' && /\.(tsx|jsx)$/.test(codeFiles.find((f) => owner(f) === c) ?? ''))) c.kind = 'frontend';
    else if (m && m.bin.length) c.kind = 'tooling';
    else if (contentMode) c.kind = byName && ['docs', 'infra', 'tooling', 'config', 'tests'].includes(byName) ? byName : 'docs';
    else if (singleProject && projCats.has('Backend') && !projCats.has('Frontend')) c.kind = 'backend';
    else if (singleProject && projCats.has('Frontend') && !projCats.has('Backend')) c.kind = 'frontend';
    else c.kind = 'library';
    if (c.merged) c.kind = 'library';
  }
  // entry point of each component
  const ENTRY = /(^|\/)(main|index|app|server|__main__|manage|program|application|cli|run)\.(js|mjs|cjs|ts|tsx|py|go|java|kt|cs|rb|php|rs)$/i;
  const entries = [];
  for (const c of comps) {
    const m = c.manifest && c.manifest.dir === c.path ? c.manifest : null;
    let e = '';
    if (m?.scripts?.start) { const f = /(?:node|ts-node|tsx|nodemon|bun)\s+(?:--\S+\s+)*([\w./-]+\.(?:js|mjs|ts))/.exec(m.scripts.start)?.[1]; if (f) e = joinPath(c.path, f); }
    if (!e && m?.main) e = joinPath(c.path, m.main);
    if (!e || !pathSet.has(e)) e = codeFiles.filter((f) => owner(f) === c && ENTRY.test(f)).sort((a, b) => a.split('/').length - b.split('/').length)[0] ?? '';
    if (e) { c.entry = e; entries.push({ file: e, component: c.name, why: m?.scripts?.start ? `start script: ${clipText(m.scripts.start, 50)}` : 'conventional entry file' }); }
  }
  for (const m of manifests.filter((x) => x.bin.length)) for (const b of m.bin) entries.push({ file: joinPath(m.dir, b), component: m.name || baseOf(m.dir) || 'project', why: 'command-line entry (bin)' });
  for (const d of dockerfiles) if (d.cmd) entries.push({ file: d.path, component: dirOf(d.path) || 'root', why: `container command: ${d.cmd}` });

  // ------------------------------------------------------------ imports between components
  const pkgNames = new Map(); for (const c of comps) { const m = c.manifest && c.manifest.dir === c.path ? c.manifest : null; if (m?.name) pkgNames.set(m.name, c); }
  const goModule = manifests.find((m) => m.kind === 'go')?.name ?? '';
  const javaPkg = new Map();                                                         // java package -> component
  for (const f of codeFiles) if (/\.(java|kt)$/.test(f) && byPath.has(f)) { const pk = /^\s*package\s+([\w.]+)/m.exec(byPath.get(f))?.[1]; if (pk && !javaPkg.has(pk)) javaPkg.set(pk, owner(f)); }
  const resolveSpec = (file, lang, spec, from) => {
    const tryPath = (p) => { for (const cand of [p, `${p}.ts`, `${p}.tsx`, `${p}.js`, `${p}.jsx`, `${p}.mjs`, `${p}.py`, `${p}/index.ts`, `${p}/index.js`, `${p}/__init__.py`]) if (pathSet.has(cand)) return owner(cand); const pre = `${p}/`; const hit = allPaths.find((x) => x.startsWith(pre)); return hit ? owner(hit) : null; };
    if (lang === 'Python') {
      if (spec.startsWith('.')) { const dots = /^\.+/.exec(spec)[0].length; let base = dirOf(file); for (let i = 1; i < dots; i++) base = dirOf(base); return tryPath(joinPath(base, spec.slice(dots).replace(/\./g, '/'))); }
      const rel = spec.replace(/\./g, '/');
      for (const base of ['', 'src', ...comps.map((c) => c.path)]) { const hit = tryPath(joinPath(base, rel)) ?? tryPath(joinPath(base, rel.split('/').slice(0, -1).join('/'))); if (hit) return hit; }
      return null;
    }
    if (lang === 'Go') { if (goModule && spec.startsWith(`${goModule}/`)) return tryPath(spec.slice(goModule.length + 1)); return null; }
    if (lang === 'Java' || lang === 'Kotlin') { const parts = spec.split('.'); for (let i = parts.length; i > 1; i--) { const c = javaPkg.get(parts.slice(0, i).join('.')); if (c) return c; } return null; }
    // JS / TS / Vue / Svelte
    if (spec.startsWith('.')) return tryPath(joinPath(dirOf(file), spec));
    if (spec.startsWith('@/') || spec.startsWith('~/')) return tryPath(joinPath('src', spec.slice(2))) ?? tryPath(spec.slice(2));
    const wsPkg = [...pkgNames].find(([n]) => spec === n || spec.startsWith(`${n}/`));
    return wsPkg ? wsPkg[1] : null;
  };
  const edgeCount = new Map();
  for (const f of codeFiles.slice(0, 6000)) {
    const lang = LANG[extOf(f)];
    if (!IMPORT_LANGS.has(lang) || !byPath.has(f)) continue;
    const from = owner(f); if (!from) continue;
    for (const spec of uniq(importsOf(lang, byPath.get(f)))) {
      const to = resolveSpec(f, lang, spec, from);
      if (to && to !== from) { const k = `${from.id}>${to.id}`; edgeCount.set(k, (edgeCount.get(k) ?? 0) + 1); }
    }
  }
  const importEdges = [...edgeCount].map(([k, n]) => { const [a, b] = k.split('>'); return { from: a, to: b, count: n }; }).sort((x, y) => y.count - x.count).slice(0, 40);

  // ------------------------------------------------------------ diagram model
  const nodes = []; const edges = [];
  const addNode = (n) => { if (!nodes.some((x) => x.id === n.id)) nodes.push(n); return n; };
  const addEdge = (e) => { if (e.from !== e.to && nodes.some((n) => n.id === e.from) && nodes.some((n) => n.id === e.to) && !edges.some((x) => x.from === e.from && x.to === e.to)) edges.push(e); };
  const groupOf = { frontend: 'frontend', mobile: 'frontend', backend: 'backend', data: 'backend', library: 'library', other: 'library', tooling: 'support', config: 'support', tests: 'support', docs: 'content', infra: 'infra' };
  for (const c of comps) {
    addNode({ id: c.id, label: c.name, kind: c.kind, group: groupOf[c.kind] ?? 'library', sub: `${c.language || 'code'} · ${plural(c.files, 'file')}`, path: c.path, entry: c.entry, techs: uniq(c.techs.map((t) => t.label)).slice(0, 4) });
  }
  for (const e of importEdges) addEdge({ from: e.from, to: e.to, label: e.count > 1 ? `${e.count} imports` : 'imports', weight: e.count, basis: 'imports' });
  const frontends = comps.filter((c) => c.kind === 'frontend' || c.kind === 'mobile');
  const backends = comps.filter((c) => c.kind === 'backend');
  // docker-compose: services become boxes; depends_on is a real edge
  const compIdOfService = new Map();
  for (const s of compose) {
    const imgNode = s.image ? IMAGE_NODE.find(([re]) => re.test(s.image)) : null;
    const ctx = s.build ? joinPath(dirOf(s.file), s.build.replace(/^\.\/?/, '')) : '';
    const comp = ctx !== '' || s.build ? comps.find((c) => c.path === ctx || (ctx && c.path.startsWith(`${ctx}/`)) || (ctx === '' && c.path === '')) : null;
    if (comp) { compIdOfService.set(s.name, comp.id); continue; }
    const id = `svc:${s.name}`;
    addNode({ id, label: imgNode?.[1] ?? s.name, kind: 'external', group: 'data', sub: imgNode ? `${imgNode[2]} · compose service "${s.name}"` : `compose service "${s.name}"${s.image ? ` · ${clipText(s.image, 24)}` : ''}`, category: imgNode?.[2] ?? 'Service' });
    compIdOfService.set(s.name, id);
  }
  for (const s of compose) for (const d of s.dependsOn) { const a = compIdOfService.get(s.name); const b = compIdOfService.get(d); if (a && b) addEdge({ from: a, to: b, label: 'depends_on', basis: 'docker-compose' }); }
  // external services from dependencies / env names (a service already drawn from compose is reused)
  const extNodes = new Map();
  const ext = (label, category, source) => {
    const existing = nodes.find((n) => n.group === 'data' && n.category === category && (n.label === label || (n.kind === 'external' && n.id.startsWith('svc:') && n.label === label)));
    if (existing) return existing.id;
    const id = `ext:${label}`; if (!extNodes.has(id)) { extNodes.set(id, true); addNode({ id, label, kind: 'external', group: 'data', sub: category, category, source }); } return id;
  };
  for (const [m, list] of techByManifest) {
    for (const t of list) {
      if (!t.node || t.dev) continue;
      const id = ext(t.label, t.node, `${t.dep} in ${m.path}`);
      const owners = comps.filter((c) => c.manifest === m && c.manifest.dir === c.path);
      const targets = owners.length ? owners : (m.dir === '' ? (backends.length ? backends : comps.slice(0, 1)) : comps.filter((c) => c.path === m.dir || c.path.startsWith(`${m.dir}/`)));
      for (const c of targets) addEdge({ from: c.id, to: id, label: t.label === 'Authentication' ? 'auth' : '', basis: owners.length ? 'dependency' : 'inferred', inferred: !owners.length });
    }
  }
  const have = new Set(nodes.map((n) => n.category).filter(Boolean));
  for (const v of envVars) { const hint = ENV_HINTS.find(([re]) => re.test(v)); if (hint && !have.has(hint[1])) { have.add(hint[1]); const id = ext(hint[1], hint[1], `${v} in env example`); for (const c of (backends.length ? backends : comps.slice(0, 1))) addEdge({ from: c.id, to: id, label: '', basis: 'env', inferred: true }); } }
  // users -> frontends / backends, frontends -> backends
  if (frontends.length || backends.length) {
    addNode({ id: 'users', label: frontends.length ? 'Users (browser / app)' : 'Clients', kind: 'users', group: 'users', sub: 'inferred' });
    for (const c of (frontends.length ? frontends : backends)) addEdge({ from: 'users', to: c.id, label: frontends.length ? 'uses' : 'calls API', basis: 'inferred', inferred: true });
  }
  for (const f of frontends) for (const b of backends) if (!edges.some((e) => (e.from === f.id && e.to === b.id) || (e.from === b.id && e.to === f.id))) addEdge({ from: f.id, to: b.id, label: 'HTTP API', basis: 'inferred', inferred: true });
  // infrastructure files
  if (dockerfiles.length) { addNode({ id: 'infra:docker', label: 'Container image', kind: 'infra', group: 'infra', sub: `${dockerfiles.length} Dockerfile${dockerfiles.length === 1 ? '' : 's'}${dockerfiles[0].from ? ` · ${clipText(dockerfiles[0].from, 22)}` : ''}` }); const c = owner(`${dockerfiles[0].dir ? `${dockerfiles[0].dir}/` : ''}x`) ?? comps[0]; if (c) addEdge({ from: 'infra:docker', to: c.id, label: 'runs', basis: 'Dockerfile' }); }
  const ciSystems = [...(workflows.length ? [{ system: 'GitHub Actions', detail: workflows.flatMap((w) => w.jobs).slice(0, 6), deploy: workflows.some((w) => w.deploy) }] : []), ...otherCi];
  for (const ci of ciSystems) { addNode({ id: `ci:${ci.system}`, label: `CI/CD · ${ci.system}`, kind: 'infra', group: 'infra', sub: ci.detail?.length ? clipText(ci.detail.join(', '), 40) : 'pipeline' }); if (dockerfiles.length) addEdge({ from: `ci:${ci.system}`, to: 'infra:docker', label: 'builds', basis: 'inferred', inferred: true }); }
  if (Object.keys(k8sKinds).length || helm.length) addNode({ id: 'infra:k8s', label: 'Kubernetes', kind: 'infra', group: 'infra', sub: helm.length ? `Helm chart${helm.length > 1 ? 's' : ''}` : Object.entries(k8sKinds).slice(0, 3).map(([k, n]) => `${n} ${k}`).join(', ') });
  if (tfFiles.length) addNode({ id: 'infra:tf', label: 'Terraform', kind: 'infra', group: 'infra', sub: `${tfResources} resource${tfResources === 1 ? '' : 's'} · use the Terraform view` });
  if (infraLink(nodes, 'infra:k8s') && dockerfiles.length) addEdge({ from: 'infra:docker', to: 'infra:k8s', label: 'deployed to', basis: 'inferred', inferred: true });

  const techs = [...techAll.values()].filter((t) => !(t.dev && t.cat !== 'Testing' && t.cat !== 'Build')).sort((a, b) => ['Frontend', 'Mobile', 'Backend', 'API', 'Database', 'Cache', 'Message queue', 'Search', 'Cloud', 'Auth', 'Payments', 'AI', 'Monitoring', 'Messaging', 'Data access', 'Build', 'Testing'].indexOf(a.cat) - ['Frontend', 'Mobile', 'Backend', 'API', 'Database', 'Cache', 'Message queue', 'Search', 'Cloud', 'Auth', 'Payments', 'AI', 'Monitoring', 'Messaging', 'Data access', 'Build', 'Testing'].indexOf(b.cat));

  // catalog-style README: one box per listed topic, so the map shows what the repository is about
  const catalog = contentMode && readmePath && byPath.has(readmePath) ? parseCatalog(byPath.get(readmePath)) : null;
  if (catalog && catalog.sections.length >= 3) {
    nodes.length = 0; edges.length = 0;
    addNode({ id: 'cat:reader', label: 'Learner', kind: 'users', group: 'users', sub: 'reads the README' });
    addNode({ id: 'cat:readme', label: readme.title || 'README', kind: 'docs', group: 'content', sub: `${plural(catalog.sections.length, 'topic')} · ${plural(catalog.links, 'link')}` });
    addEdge({ from: 'cat:reader', to: 'cat:readme', label: 'browses' });
    catalog.sections.slice(0, 60).forEach((sec, i) => {
      const id = `cat:${i}`;
      addNode({ id, label: sec.title, kind: 'docs', group: 'data', sub: `${plural(sec.count, 'link')}${sec.parent ? ` · ${clipText(sec.parent, 22)}` : ''}` });
      addEdge({ from: 'cat:readme', to: id, label: '' });
    });
  }
  // file tree (3 levels, with counts) for display
  const treeText = buildTreeText(allPaths);
  const description = plainText(rootManifest?.description || readme.intro.split('\n')[0] || '');
  const model = {
    name: name || rootManifest?.name || readme.title || '', description, languages, fileCount: allPaths.length, codeFiles: codeFiles.length, docFiles, contentRepo: Boolean(contentMode),
    catalog: catalog && catalog.sections.length >= 3 ? catalog : null,
    outline: readme.headings.filter((h) => h.level === 2).map((h) => h.text).slice(0, 14),
    readme, techs, manifests: manifests.map((m) => ({ path: m.path, kind: m.kind, name: m.name, scripts: Object.keys(m.scripts).slice(0, 8) })),
    components: comps.map((c) => ({ id: c.id, name: c.name, path: c.path, kind: c.kind, language: c.language, files: c.files, entry: c.entry, techs: uniq(c.techs.map((t) => t.label)) })),
    imports: importEdges.map((e) => ({ from: comps.find((c) => c.id === e.from)?.name, to: comps.find((c) => c.id === e.to)?.name, count: e.count })),
    entries: entries.slice(0, 12),
    infrastructure: { dockerfiles, compose: compose.map((s) => ({ name: s.name, image: s.image, build: s.build, ports: s.ports, dependsOn: s.dependsOn, file: s.file })), ci: ciSystems, kubernetes: { kinds: k8sKinds, helm }, terraform: { files: tfFiles.length, resources: tfResources } },
    openapi, env: envVars.slice(0, 40), notes, treeText,
    diagram: { nodes, edges },
  };
  model.explanation = explain(model);
  return model;
}
const infraLink = (nodes, id) => nodes.some((n) => n.id === id);

function buildTreeText(paths) {
  const root = {};
  for (const p of paths) { let cur = root; const parts = p.split('/'); for (let i = 0; i < parts.length - 1 && i < 3; i++) { cur[parts[i]] ??= { __n: 0 }; cur = cur[parts[i]]; cur.__n++; } if (parts.length <= 3 && parts.length === 1) (root.__files ??= []).push(p); }
  const lines = [];
  const walk = (node, indent) => {
    const dirs = Object.keys(node).filter((k) => k !== '__n' && k !== '__files').sort();
    for (const d of dirs) { lines.push(`${indent}${d}/  (${node[d].__n} files)`); if (lines.length < 140) walk(node[d], `${indent}  `); }
  };
  walk(root, '');
  for (const f of (root.__files ?? []).sort().slice(0, 30)) lines.push(f);
  return lines.slice(0, 160).join('\n');
}

// plain-language summary assembled from the facts (no AI)
function explain(m) {
  const out = [];
  const lead = m.description || m.readme.intro.split('\n')[0];
  if (lead) out.push(`${m.name ? `${m.name}: ` : ''}${clipText(lead, 400)}`);
  if (m.contentRepo) {
    out.push(`This repository holds no source code: it is a collection of documents and data (${m.docFiles} text documents out of ${m.fileCount} files).`);
    if (m.catalog) {
      const big = [...m.catalog.sections].sort((a, b) => b.count - a.count).slice(0, 4).map((x) => `${x.title} (${x.count})`);
      out.push(`The README is a catalog: ${plural(m.catalog.sections.length, 'topic')} that together list ${plural(m.catalog.links, 'link')}${m.catalog.hosts.length ? `, mostly to ${m.catalog.hosts.slice(0, 3).map((h) => h.host).join(', ')}` : ''}. The longest lists are ${big.join(', ')}.`);
    } else if (m.outline.length) out.push(`The README's main sections: ${m.outline.join(', ')}.`);
  }
  const langs = m.languages.slice(0, 3).map((l) => `${l.name} ${Math.round(l.percent)}%`).join(', ');
  const stack = m.techs.filter((t) => !['Build', 'Testing', 'Data access'].includes(t.cat)).slice(0, 8).map((t) => t.label);
  if (!m.contentRepo && (langs || stack.length)) out.push(`It is written mostly in ${langs || 'several languages'}${stack.length ? ` and uses ${stack.join(', ')}` : ''}.`);
  if (m.contentRepo && m.languages.length) out.push(`The files are mostly ${m.languages.slice(0, 2).map((l) => l.name).join(' and ')}.`);
  if (m.components.length) {
    const parts = m.components.slice(0, 8).map((c) => `${c.name} (${c.kind}${c.files ? `, ${plural(c.files, 'file')}` : ''})`);
    out.push(`The ${m.contentRepo ? 'repository' : 'code'} is organised into ${m.components.length} part${m.components.length === 1 ? '' : 's'}: ${parts.join('; ')}${m.components.length > 8 ? '; …' : ''}.`);
  }
  const strong = m.imports.slice(0, 4).map((e) => `${e.from} → ${e.to} (${plural(e.count, 'import')})`);
  if (strong.length) out.push(`The strongest links between parts, read from the imports: ${strong.join('; ')}.`);
  const flow = [];
  const nodes = m.diagram.nodes;
  if (nodes.some((n) => n.group === 'users')) flow.push('users');
  for (const g of ['frontend', 'backend']) { const names = nodes.filter((n) => n.group === g).map((n) => n.label); if (names.length) flow.push(names.slice(0, 3).join(' / ')); }
  const data = nodes.filter((n) => n.group === 'data').map((n) => n.label);
  if (data.length) flow.push(data.slice(0, 4).join(', '));
  if (flow.length > 1) out.push(`Typical flow (inferred): ${flow.join(' → ')}.`);
  const scripts = m.manifests.find((x) => x.scripts.length);
  if (m.readme.run.length) out.push(`To run it, the README says: ${m.readme.run[0].lines.filter((l) => l.trim() && !l.trim().startsWith('#')).slice(0, 3).join(' ; ')}`);
  else if (scripts) out.push(`Available scripts (${scripts.path}): ${scripts.scripts.join(', ')}.`);
  const infra = [];
  if (m.infrastructure.dockerfiles.length) infra.push(`${m.infrastructure.dockerfiles.length} Dockerfile${m.infrastructure.dockerfiles.length === 1 ? '' : 's'}`);
  if (m.infrastructure.compose.length) infra.push(`docker-compose with ${m.infrastructure.compose.length} services (${m.infrastructure.compose.slice(0, 5).map((s) => s.name).join(', ')})`);
  if (m.infrastructure.ci.length) infra.push(`${m.infrastructure.ci.map((c) => c.system).join(' and ')} pipelines`);
  if (Object.keys(m.infrastructure.kubernetes.kinds).length || m.infrastructure.kubernetes.helm.length) infra.push('Kubernetes manifests');
  if (m.infrastructure.terraform.files) infra.push(`Terraform (${m.infrastructure.terraform.resources} resources: open it in the Terraform view)`);
  if (infra.length) out.push(`Delivery and infrastructure: ${infra.join(', ')}.`);
  if (m.openapi.length) out.push(`API description: ${m.openapi.map((o) => `${o.path} (${o.endpoints} endpoints)`).join(', ')}.`);
  return out;
}

// ---------------------------------------------------------------- text for AI and MCP
const KEY_FILE = /(^|\/)(package\.json|pom\.xml|go\.mod|Cargo\.toml|pyproject\.toml|requirements\.txt|Dockerfile|docker-compose\.ya?ml|compose\.ya?ml|openapi\.[\w]+|Makefile|\.env\.example)$/i;
export function repoContext(model, files, { maxChars = 60000, focus = [] } = {}) {
  const parts = [];
  parts.push(`# Repository: ${model.name || '(unnamed)'}`);
  if (model.description) parts.push(`Description: ${model.description}`);
  parts.push(`Files: ${model.fileCount} (${model.codeFiles} source files). Languages: ${model.languages.map((l) => `${l.name} ${l.percent}%`).join(', ')}`);
  parts.push(`\n## Folder structure (top 3 levels)\n${model.treeText}`);
  if (model.techs.length) parts.push(`\n## Technologies detected\n${model.techs.map((t) => `- ${t.label} (${t.cat}) — ${t.evidence[0]}`).join('\n')}`);
  parts.push(`\n## Components found by the tool\n${model.components.map((c) => `- ${c.name} [${c.kind}] ${c.path || '/'} — ${c.language}, ${c.files} files${c.entry ? `, entry ${c.entry}` : ''}${c.techs.length ? `, uses ${c.techs.join(', ')}` : ''}`).join('\n')}`);
  if (model.imports.length) parts.push(`\n## Imports between components\n${model.imports.map((e) => `- ${e.from} -> ${e.to} (${e.count})`).join('\n')}`);
  const inf = model.infrastructure;
  const infra = [];
  for (const d of inf.dockerfiles) infra.push(`Dockerfile ${d.path}: FROM ${d.from}${d.expose.length ? `, EXPOSE ${d.expose.join(' ')}` : ''}${d.cmd ? `, ${d.cmd}` : ''}`);
  for (const s of inf.compose) infra.push(`compose service ${s.name}: ${s.image || `build ${s.build}`}${s.ports.length ? ` ports ${s.ports.join(',')}` : ''}${s.dependsOn.length ? ` depends_on ${s.dependsOn.join(',')}` : ''}`);
  for (const c of inf.ci) infra.push(`CI ${c.system}: ${c.detail.join(', ')}${c.deploy ? ' (deploys)' : ''}`);
  if (Object.keys(inf.kubernetes.kinds).length) infra.push(`Kubernetes kinds: ${Object.entries(inf.kubernetes.kinds).map(([k, n]) => `${k} ${n}`).join(', ')}`);
  if (inf.terraform.files) infra.push(`Terraform: ${inf.terraform.files} files, ${inf.terraform.resources} resources`);
  if (infra.length) parts.push(`\n## Infrastructure and delivery\n${infra.join('\n')}`);
  if (model.entries.length) parts.push(`\n## Entry points\n${model.entries.map((e) => `- ${e.file} (${e.component}): ${e.why}`).join('\n')}`);
  if (model.env.length) parts.push(`\n## Environment variables (names only)\n${model.env.join(', ')}`);
  let text = parts.join('\n');
  const room = () => maxChars - text.length;
  const add = (title, body, cap) => { const t = `\n\n## ${title}\n${clipText(body, Math.min(cap, Math.max(0, room() - 200)))}`; if (room() > 300) text += t; };
  if (model.catalog) add('Topics the README lists', model.catalog.sections.map((x) => `- ${x.title} (${x.count} links): ${x.sample.map((i) => i.text).join('; ')}`).join('\n'), 9000);
  if (model.readme.path) add(`README (${model.readme.path})`, files.find((f) => f.path === model.readme.path)?.content ?? '', 9000);
  const wanted = [...focus, ...model.entries.map((e) => e.file), ...files.map((f) => f.path).filter((p) => KEY_FILE.test(p))];
  for (const p of uniq(wanted)) { const f = files.find((x) => x.path === p); if (f && room() > 600) add(`File ${p}`, f.content, 3500); }
  return text;
}
