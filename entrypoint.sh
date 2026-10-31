#!/bin/sh
set -eu
# A newly attached persistent disk may be root-owned. Prepare only its mount root,
# then run the application without root privileges. Never delete database files.
install -d -m 0700 -o 10001 -g 10001 "${VC_DATA_DIR:-/var/lib/yengolf}"
exec runuser -u yengolf -- "$@"
