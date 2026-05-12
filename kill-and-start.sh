#!/bin/bash
# Kill process 42452 and start server
sudo kill -9 42452 2>/dev/null
sleep 2
cd /home/noname/Desktop/drone_radio_tokivoki_all-freq-scann-locator
NODE_ENV=production node server.js
