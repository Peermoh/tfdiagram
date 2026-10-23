// A .tfvars file only holds values, so nothing can be drawn from it for certain. This turns the VARIABLE NAMES in
// it into a rough Terraform sketch (vpc_cidr, public_subnets, instance_count, db_engine ...) that goes through the normal
// pipeline. Everything it makes is a guess and the page says so.
import { parseLocals } from './parse.js';

const q = (s) => JSON.stringify(s);
const num = (v) => { const m = /^\s*(\d+)\s*$/.exec(String(v ?? '')); return m ? Number(m[1]) : null; };
const truthy = (v) => /^\s*true\s*$/i.test(String(v ?? ''));
const falsy = (v) => /^\s*(false|null|0|""|\[\s*\]|\{\s*\})\s*$/i.test(String(v ?? ''));
const str = (v) => { const m = /^\s*"([^"]*)"\s*$/.exec(String(v ?? '')); return m ? m[1] : null; };
const listOf = (v) => {
  const m = /^\s*\[([\s\S]*)\]\s*$/.exec(String(v ?? ''));
  if (!m) return null;
  return [...m[1].matchAll(/"([^"]*)"/g)].map((x) => x[1]);
};

// does this text look like a tfvars file (assignments, no resource / module / data / variable blocks)?
export function looksLikeTfvars(text) {
  return !/^\s*(resource|module|data|variable|provider|terraform|locals|output)\b/m.test(text) && /^\s*[A-Za-z_][\w-]*\s*=/m.test(text);
}

export function sketchFromTfvars(text) {
  const vars = {};
  for (const [k, v] of Object.entries(parseLocals(text))) vars[k.toLowerCase()] = v.trim();
  const keys = Object.keys(vars);
  const find = (re) => keys.find((k) => re.test(k));
  const val = (re) => vars[find(re)];
  const on = (re) => { const k = find(re); return k !== undefined && !falsy(vars[k]); };
  const notes = [];
  const out = [];
  const azure = keys.some((k) => /^(location|resource_group|rg_|vnet|address_space|subnet_prefix|vm_size|storage_account|aks_|azurerm)/.test(k)) && !keys.some((k) => /^(aws_|region$|vpc|ami|instance_type)/.test(k));

  if (azure) {
    const space = listOf(val(/address_space|vnet_cidr|vnet_address|cidr/)) ?? [str(val(/address_space|vnet_cidr|cidr/)) ?? '10.0.0.0/16'];
    out.push('resource "azurerm_resource_group" "rg" {\n  name     = "sketch-rg"\n  location = "westeurope"\n}');
    out.push(`resource "azurerm_virtual_network" "vnet" {\n  name                = "vnet"\n  address_space       = ${JSON.stringify(space)}\n  location            = azurerm_resource_group.rg.location\n  resource_group_name = azurerm_resource_group.rg.name\n}`);
    const subnets = listOf(val(/subnet_prefix|subnet_cidr|subnets?$/)) ?? [];
    const names = listOf(val(/subnet_names?$/)) ?? [];
    subnets.slice(0, 8).forEach((cidr, i) => out.push(`resource "azurerm_subnet" "${(names[i] ?? `subnet${i}`).replace(/[^\w]/g, '_')}" {\n  name                 = ${q(names[i] ?? `subnet${i}`)}\n  resource_group_name  = azurerm_resource_group.rg.name\n  virtual_network_name = azurerm_virtual_network.vnet.name\n  address_prefixes     = [${q(cidr)}]\n}`));
    const first = subnets.length ? `azurerm_subnet.${(names[0] ?? 'subnet0').replace(/[^\w]/g, '_')}.id` : null;
    if (find(/vm_size|vm_count|vm_name|admin_username/) && first) {
      const n = num(val(/vm_count|instance_count/)) ?? 1;
      out.push(`resource "azurerm_public_ip" "pip" {\n  name                = "pip"\n  location            = azurerm_resource_group.rg.location\n  resource_group_name = azurerm_resource_group.rg.name\n  allocation_method   = "Static"\n}`);
      out.push(`resource "azurerm_network_interface" "nic" {\n  name                = "nic"\n  location            = azurerm_resource_group.rg.location\n  resource_group_name = azurerm_resource_group.rg.name\n  ip_configuration {\n    name                          = "internal"\n    subnet_id                     = ${first}\n    private_ip_address_allocation = "Dynamic"\n    public_ip_address_id          = azurerm_public_ip.pip.id\n  }\n}`);
      out.push(`resource "azurerm_linux_virtual_machine" "vm" {\n  count                 = ${n}\n  name                  = "vm"\n  resource_group_name   = azurerm_resource_group.rg.name\n  location              = azurerm_resource_group.rg.location\n  size                  = ${q(str(val(/vm_size/)) ?? 'Standard_B2s')}\n  network_interface_ids = [azurerm_network_interface.nic.id]\n}`);
    }
    if (find(/storage/)) out.push('resource "azurerm_storage_account" "data" {\n  name                     = "storage"\n  resource_group_name      = azurerm_resource_group.rg.name\n  location                 = azurerm_resource_group.rg.location\n  account_tier             = "Standard"\n  account_replication_type = "LRS"\n}');
    if (find(/sql|database/)) out.push('resource "azurerm_mssql_server" "sql" {\n  name                = "sql"\n  resource_group_name = azurerm_resource_group.rg.name\n  location            = azurerm_resource_group.rg.location\n  version             = "12.0"\n}\nresource "azurerm_mssql_database" "db" {\n  name      = "db"\n  server_id = azurerm_mssql_server.sql.id\n}');
    if (find(/key_?vault|kv_/)) out.push('resource "azurerm_key_vault" "kv" {\n  name                = "kv"\n  location            = azurerm_resource_group.rg.location\n  resource_group_name = azurerm_resource_group.rg.name\n  tenant_id           = "00000000-0000-0000-0000-000000000000"\n  sku_name            = "standard"\n}');
    if (out.length <= 2) return null;
    notes.push('Azure resources inferred from variable names (location, address space, subnet prefixes, VM size, storage, SQL, Key Vault).');
    return { code: out.join('\n\n'), notes };
  }

  // ---- AWS
  const cidrKey = find(/^(vpc_)?cidr(_block)?$|vpc_cidr|vpc_block/);
  const pub = listOf(val(/public.*(subnet|cidr)|(subnet|cidr).*public/));
  const priv = listOf(val(/(private|app).*(subnet|cidr)|(subnet|cidr).*(private|app)/));
  const dbs = listOf(val(/(database|db|data).*(subnet|cidr)|(subnet|cidr).*(database|db)/));
  const hasNet = cidrKey || pub || priv || dbs;
  if (hasNet) {
    out.push(`resource "aws_vpc" "vpc" {\n  cidr_block = ${cidrKey ? vars[cidrKey] : '"10.0.0.0/16"'}\n  tags = { Name = "vpc" }\n}`);
    const subnet = (kind, cidrs) => (cidrs ?? []).slice(0, 8).forEach((c, i) => out.push(`resource "aws_subnet" "${kind}_${i}" {\n  vpc_id     = aws_vpc.vpc.id\n  cidr_block = ${q(c)}\n  tags = { Name = "${kind}-${i}" }\n}`));
    subnet('public', pub); subnet('private', priv); subnet('database', dbs);
    if (pub?.length) out.push('resource "aws_internet_gateway" "igw" {\n  vpc_id = aws_vpc.vpc.id\n}');
    if (on(/nat/)) out.push(`resource "aws_eip" "nat" {\n  domain = "vpc"\n}\nresource "aws_nat_gateway" "nat" {\n  allocation_id = aws_eip.nat.id\n  subnet_id     = ${pub?.length ? 'aws_subnet.public_0.id' : 'aws_vpc.vpc.id'}\n}`);
  }
  const appSubnet = priv?.length ? 'aws_subnet.private_0.id' : pub?.length ? 'aws_subnet.public_0.id' : null;
  const wantsInstances = find(/instance_count|ec2_count|app_count|server_count|desired_(capacity|count)|min_size|^instance_type$|^ami|ec2_instance_type|app_instance_type/);
  let instances = false;
  if (wantsInstances) {
    const n = num(val(/instance_count|ec2_count|app_count|server_count|desired_(capacity|count)/)) ?? num(val(/min_size/)) ?? 1;
    if (n > 0) {
      instances = true;
      out.push(`resource "aws_instance" "app" {\n  count         = ${n}\n  ami           = "ami-sketch"\n  instance_type = ${q(str(val(/instance_type/)) ?? 't3.micro')}\n${appSubnet ? `  subnet_id     = ${appSubnet}\n` : ''}}`);
    }
  }
  if (on(/(^|_)(alb|elb|lb|load_balancer)(_|$)|listener|target_group/) && (pub?.length || instances)) {
    out.push(`resource "aws_lb" "alb" {\n  name    = "alb"\n  subnets = [${(pub ?? []).slice(0, 2).map((_, i) => `aws_subnet.public_${i}.id`).join(', ')}]\n}`);
    if (instances) out.push('resource "aws_lb_target_group" "app" {\n  name     = "app"\n  port     = 80\n  protocol = "HTTP"\n  vpc_id   = aws_vpc.vpc.id\n}\nresource "aws_lb_listener" "http" {\n  load_balancer_arn = aws_lb.alb.arn\n  port              = 80\n  protocol          = "HTTP"\n  default_action {\n    type             = "forward"\n    target_group_arn = aws_lb_target_group.app.arn\n  }\n}\nresource "aws_lb_target_group_attachment" "app" {\n  target_group_arn = aws_lb_target_group.app.arn\n  target_id        = aws_instance.app[0].id\n}');
  }
  if (find(/(^|_)(db|rds|database)(_|$)|engine$|db_instance|db_engine/)) {
    const eng = str(val(/engine$|db_engine/)) ?? 'postgres';
    const dbSub = dbs?.length ? dbs.slice(0, 3).map((_, i) => `aws_subnet.database_${i}.id`) : priv?.length ? priv.slice(0, 2).map((_, i) => `aws_subnet.private_${i}.id`) : [];
    if (dbSub.length) out.push(`resource "aws_db_subnet_group" "db" {\n  name       = "db"\n  subnet_ids = [${dbSub.join(', ')}]\n}`);
    out.push(`resource "aws_db_instance" "db" {\n  engine         = ${q(eng)}\n  instance_class = ${q(str(val(/db_instance_class|instance_class/)) ?? 'db.t3.micro')}\n${dbSub.length ? '  db_subnet_group_name = aws_db_subnet_group.db.name\n' : ''}${instances ? '  tags = { app = aws_instance.app[0].id }\n' : ''}}`);
  }
  if (on(/bucket|s3/)) out.push(`resource "aws_s3_bucket" "bucket" {\n  bucket = ${q(str(val(/bucket(_name)?$/)) ?? 'sketch-bucket')}\n}`);
  if (find(/eks|kubernetes_version|cluster_version/)) out.push(`resource "aws_eks_cluster" "eks" {\n  name     = ${q(str(val(/cluster_name|eks_name/)) ?? 'eks')}\n  role_arn = "arn:aws:iam::000000000000:role/sketch"\n  vpc_config {\n    subnet_ids = [${(priv ?? pub ?? []).slice(0, 2).map((_, i) => `aws_subnet.${priv ? 'private' : 'public'}_${i}.id`).join(', ')}]\n  }\n}`);
  if (find(/lambda|function_name/)) out.push(`resource "aws_lambda_function" "fn" {\n  function_name = ${q(str(val(/function_name/)) ?? 'fn')}\n  role          = "arn:aws:iam::000000000000:role/sketch"\n  handler       = "index.handler"\n  runtime       = ${q(str(val(/runtime/)) ?? 'nodejs20.x')}\n}`);
  if (!out.length) return null;
  notes.push('AWS resources inferred from variable names (vpc cidr, subnet lists, instance count/type, load balancer, database, bucket, EKS, Lambda).');
  return { code: out.join('\n\n'), notes };
}
