variable "APP_VERSION" {
  default = "dev"
}

variable "NODE_IMAGE" {
  default = "node:24-bookworm-slim"
}

variable "GOPROXY" {
  default = "https://proxy.golang.org,direct"
}

variable "GOSUMDB" {
  default = "sum.golang.google.cn"
}

# BuildKit recognizes these predefined proxy build args without persisting them
# in image history. Matching environment variables override the empty defaults.
variable "HTTP_PROXY" {
  default = ""
}

variable "HTTPS_PROXY" {
  default = ""
}

variable "NO_PROXY" {
  default = ""
}

variable "http_proxy" {
  default = ""
}

variable "https_proxy" {
  default = ""
}

variable "no_proxy" {
  default = ""
}

target "runtime-base" {
  context    = "."
  dockerfile = "Dockerfile.base"
  args = {
    NODE_IMAGE = NODE_IMAGE
    GOPROXY    = GOPROXY
    GOSUMDB    = GOSUMDB
    HTTP_PROXY = HTTP_PROXY
    HTTPS_PROXY = HTTPS_PROXY
    NO_PROXY   = NO_PROXY
    http_proxy = http_proxy
    https_proxy = https_proxy
    no_proxy   = no_proxy
  }
  tags = ["soms-base:latest"]
}

target "build-base" {
  context    = "."
  dockerfile = "Dockerfile.build-base"
  args = {
    NODE_IMAGE = NODE_IMAGE
    HTTP_PROXY = HTTP_PROXY
    HTTPS_PROXY = HTTPS_PROXY
    NO_PROXY   = NO_PROXY
    http_proxy = http_proxy
    https_proxy = https_proxy
    no_proxy   = no_proxy
  }
  tags = ["soms-build-base:latest"]
}

# Named target contexts keep both bases inside the same BuildKit graph. They are
# cacheable intermediate targets, not registry dependencies or published images.
target "app" {
  context    = "."
  dockerfile = "Dockerfile"
  contexts = {
    soms-base       = "target:runtime-base"
    soms-build-base = "target:build-base"
  }
  args = {
    APP_VERSION    = APP_VERSION
    NODE_IMAGE     = NODE_IMAGE
    SOMS_BASE      = "soms-base"
    SOMS_BUILD_BASE = "soms-build-base"
    HTTP_PROXY     = HTTP_PROXY
    HTTPS_PROXY    = HTTPS_PROXY
    NO_PROXY       = NO_PROXY
    http_proxy     = http_proxy
    https_proxy    = https_proxy
    no_proxy       = no_proxy
  }
  tags = ["soms:${APP_VERSION}", "soms:latest"]
}

group "default" {
  targets = ["app"]
}
