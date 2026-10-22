import test from 'node:test';
import assert from 'node:assert/strict';
import { matchIcons, tokens } from '../scripts/import-icons.mjs';

const AWS = [
  'Architecture-Service-Icons/Arch_Compute/64/Arch_Amazon-EC2_64.svg',
  'Architecture-Service-Icons/Arch_Compute/32/Arch_Amazon-EC2_32.svg',
  'Architecture-Service-Icons/Arch_Compute/64/Arch_AWS-Lambda_64.svg',
  'Architecture-Service-Icons/Arch_Storage/64/Arch_Amazon-Simple-Storage-Service_64.svg',
  'Architecture-Service-Icons/Arch_Networking/64/Arch_Amazon-Virtual-Private-Cloud_64.svg',
  'Architecture-Service-Icons/Arch_Networking/64/Arch_Elastic-Load-Balancing_64.svg',
  'Architecture-Service-Icons/Arch_Security/64/Arch_AWS-Identity-and-Access-Management_64.svg',
  'Resource-Icons/Res_Networking/Res_Amazon-VPC_Internet-Gateway_48.svg',
  'Resource-Icons/Res_Networking/Res_Amazon-VPC_NAT-Gateway_48.svg',
  'Resource-Icons/Res_Networking/Res_Amazon-VPC_Endpoints_48.svg',
  'Architecture-Group-Icons/Arch-Category_Compute_64.svg',
  'Architecture-Service-Icons/Arch_Compute/64/Arch_Amazon-EC2-Auto-Scaling_64.svg',
];
const AZ = [
  'Azure_Public_Service_Icons/Icons/compute/10021-icon-service-Virtual-Machine.svg',
  'Azure_Public_Service_Icons/Icons/compute/10023-icon-service-VM-Scale-Sets.svg',
  'Azure_Public_Service_Icons/Icons/networking/10061-icon-service-Virtual-Networks.svg',
  'Azure_Public_Service_Icons/Icons/networking/10062-icon-service-Load-Balancers.svg',
  'Azure_Public_Service_Icons/Icons/networking/10067-icon-service-Network-Security-Groups.svg',
  'Azure_Public_Service_Icons/Icons/networking/10079-icon-service-Virtual-Network-Gateways.svg',
  'Azure_Public_Service_Icons/Icons/security/10245-icon-service-Key-Vaults.svg',
  'Azure_Public_Service_Icons/Icons/storage/10086-icon-service-Storage-Accounts.svg',
  'Azure_Public_Service_Icons/Icons/containers/10023-icon-service-Kubernetes-Services.svg',
];

test('plural file names reduce to singular words', () => {
  assert.deepEqual(tokens('10069-icon-service-Public-IP-Addresses.svg'), ['public', 'ip', 'address']);
  assert.deepEqual(tokens('10105-icon-service-Container-Registries.svg'), ['container', 'registry']);
  assert.deepEqual(tokens('10227-icon-service-Managed-Identities.svg'), ['managed', 'identity']);
  assert.deepEqual(tokens('10032-icon-service-Disks.svg'), ['disk']);
});

test('classic (retired) service icons are never picked', () => {
  const r = matchIcons(['a/10028-icon-service-Virtual-Machines-(Classic).svg', 'a/10021-icon-service-Virtual-Machine.svg'], [[['azurerm_virtual_machine'], ['virtual machine']]]);
  assert.match(r.azurerm_virtual_machine, /10021-icon-service-Virtual-Machine\.svg$/);
});

test('file names are reduced to comparable words', () => {
  assert.deepEqual(tokens('x/Arch_Amazon-Simple-Storage-Service_64.svg'), ['amazon', 'simple', 'storage', 'service']);
  assert.deepEqual(tokens('x/10061-icon-service-Virtual-Networks.svg'), ['virtual', 'network']);
});

test('aws: picks the service icon, the largest size, and the most specific name', async () => {
  const { matchIcons: m } = await import('../scripts/import-icons.mjs');
  const table = [
    [['aws_instance'], ['ec2']], [['aws_autoscaling_group'], ['ec2 auto scaling', 'auto scaling']], [['aws_vpc'], ['virtual private cloud', 'vpc']],
    [['aws_internet_gateway'], ['internet gateway']], [['aws_nat_gateway'], ['nat gateway']], [['aws_vpc_endpoint'], ['endpoints']],
    [['aws_lb'], ['elastic load balancing']], [['aws_iam_role'], ['identity and access management', 'iam']],
    [['aws_s3_bucket'], ['simple storage service', 's3']], [['aws_lambda_function'], ['lambda']], [['aws_dynamodb_table'], ['dynamodb']],
  ];
  const r = m(AWS, table);
  assert.match(r.aws_instance, /EC2_64\.svg$/);                  // not the 32px one, not the Auto-Scaling one
  assert.match(r.aws_autoscaling_group, /EC2-Auto-Scaling_64/);
  assert.match(r.aws_vpc, /Virtual-Private-Cloud/);
  assert.match(r.aws_internet_gateway, /Internet-Gateway/);
  assert.match(r.aws_vpc_endpoint, /Endpoints/);
  assert.match(r.aws_lb, /Elastic-Load-Balancing/);
  assert.match(r.aws_iam_role, /Identity-and-Access-Management/);
  assert.match(r.aws_s3_bucket, /Simple-Storage-Service/);
  assert.match(r.aws_lambda_function, /Lambda/);
  assert.equal(r.aws_dynamodb_table, undefined);                  // not in this pack: falls back to the built-in icon
});

test('azure: plural names and shared icons', () => {
  const table = [
    [['azurerm_virtual_network'], ['virtual network']], [['azurerm_lb'], ['load balancer']],
    [['azurerm_linux_virtual_machine', 'azurerm_windows_virtual_machine'], ['virtual machine']],
    [['azurerm_linux_virtual_machine_scale_set'], ['vm scale set']], [['azurerm_network_security_group'], ['network security group']],
    [['azurerm_virtual_network_gateway'], ['virtual network gateway']], [['azurerm_key_vault'], ['key vault']],
    [['azurerm_storage_account'], ['storage account']], [['azurerm_kubernetes_cluster'], ['kubernetes service']],
  ];
  const r = matchIcons(AZ, table);
  assert.match(r.azurerm_virtual_network, /Virtual-Networks/);    // not the Gateways one
  assert.match(r.azurerm_virtual_network_gateway, /Virtual-Network-Gateways/);
  assert.equal(r.azurerm_linux_virtual_machine, r.azurerm_windows_virtual_machine);
  assert.match(r.azurerm_linux_virtual_machine, /Virtual-Machine\.svg$/);
  assert.match(r.azurerm_linux_virtual_machine_scale_set, /VM-Scale-Sets/);
  for (const t of ['azurerm_lb', 'azurerm_network_security_group', 'azurerm_key_vault', 'azurerm_storage_account', 'azurerm_kubernetes_cluster']) assert.ok(r[t], t);
});
