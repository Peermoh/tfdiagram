resource "aws_vpc" "main" { cidr_block = "10.0.0.0/16" }
resource "aws_subnet" "public" {
  vpc_id = aws_vpc.main.id # comment with aws_s3_bucket.nope
}
resource "aws_internet_gateway" "gw" { vpc_id = aws_vpc.main.id }
resource "aws_security_group" "web" {
  name   = "web-${var.env}"
  vpc_id = aws_vpc.main.id
  ingress {
    from_port = 80
  }
}
resource "aws_instance" "web" {
  subnet_id              = aws_subnet.public.id
  vpc_security_group_ids = [aws_security_group.web.id]
}
resource "aws_s3_bucket" "assets" { bucket = "assets" }
resource "aws_iam_role" "fn" { name = "fn" }
resource "aws_iam_role_policy_attachment" "fn" { role = aws_iam_role.fn.name }
resource "aws_lambda_function" "api" {
  role = aws_iam_role.fn.arn
  environment { variables = { BUCKET = aws_s3_bucket.assets.id } }
}
module "db" { source = "terraform-aws-modules/rds/aws" 
  vpc_security_group_ids = [aws_security_group.web.id] }
