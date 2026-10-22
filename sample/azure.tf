resource "azurerm_resource_group" "rg" { name = "rg" }
resource "azurerm_virtual_network" "vnet" {
  resource_group_name = azurerm_resource_group.rg.name
}
resource "azurerm_subnet" "app" {
  virtual_network_name = azurerm_virtual_network.vnet.name
}
resource "azurerm_network_security_group" "nsg" {
  resource_group_name = azurerm_resource_group.rg.name
}
resource "azurerm_subnet_network_security_group_association" "a" {
  subnet_id                 = azurerm_subnet.app.id
  network_security_group_id = azurerm_network_security_group.nsg.id
}
resource "azurerm_network_interface" "nic" {
  ip_configuration { subnet_id = azurerm_subnet.app.id }
}
resource "azurerm_linux_virtual_machine" "vm" {
  network_interface_ids = [azurerm_network_interface.nic.id]
}
resource "azurerm_storage_account" "sa" { name = "sa" }
resource "azurerm_key_vault" "kv" { name = "kv" }
