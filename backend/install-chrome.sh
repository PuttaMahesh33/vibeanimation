#!/bin/bash
# Install Chromium on Leapcell (Debian/Ubuntu based)
apt-get update -qq
apt-get install -y -qq chromium || apt-get install -y -qq chromium-browser || echo "Chrome install attempted"
which chromium || which chromium-browser || echo "Chrome path not found"
