#!/usr/bin/env bash
# Launch the compiled CLI beside this file.
#
# The bundle is `.cjs` because that is the only spelling Node reads as CommonJS
# from any working directory — including one whose package.json says
# "type": "module", which is exactly what the repo around the kit says. The name
# people and agents run has to stay `fish`, so the launchable name and the module
# format are two files rather than one.
exec node "$(dirname "$0")/fish.cjs" "$@"
