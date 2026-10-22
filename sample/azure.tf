resource "azurerm_resource_group" "main" { name = "rg-${var.prefix}" }

resource "azurerm_virtual_network" "main" {
  name                = "vnet-${var.prefix}"
  resource_group_name = azurerm_resource_group.main.name
}
resource "azurerm_subnet" "app" {
  name                 = "snet-app"
  virtual_network_name = azurerm_virtual_network.main.name
}
resource "azurerm_subnet" "data" {
  name                 = "snet-data"
  virtual_network_name = azurerm_virtual_network.main.name
}
resource "azurerm_network_security_group" "nsg" {
  name                = "nsg-app"
  resource_group_name = azurerm_resource_group.main.name
}
resource "azurerm_subnet_network_security_group_association" "a" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}
resource "azurerm_public_ip" "lb" {
  name                = "pip-lb"
  resource_group_name = azurerm_resource_group.main.name
}
resource "azurerm_lb" "main" {
  name = "lb-web"
  frontend_ip_configuration { public_ip_address_id = azurerm_public_ip.lb.id }
}
resource "azurerm_network_interface" "nic" {
  name = "nic-web"
  ip_configuration { subnet_id = azurerm_subnet.app.id }
}
resource "azurerm_linux_virtual_machine" "main" {
  name                  = "vm-web"
  network_interface_ids = [azurerm_network_interface.nic.id]
}
resource "azurerm_service_plan" "main" { name = "asp-${var.prefix}" }
resource "azurerm_linux_web_app" "api" {
  name            = "app-api"
  service_plan_id = azurerm_service_plan.main.id
}
resource "azurerm_mssql_server" "main" { name = "sql-${var.prefix}" }
resource "azurerm_mssql_database" "app" { server_id = azurerm_mssql_server.main.id }
resource "azurerm_storage_account" "main" { name = "st${var.prefix}" }
resource "azurerm_key_vault" "main" { name = "kv-${var.prefix}" }
resource "azurerm_user_assigned_identity" "app" { name = "id-app" }
