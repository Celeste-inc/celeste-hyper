#!/bin/sh
# Worker PID-1 for the fleet sim: prepare cgroup v2 so k3s/kubelet can run inside this container,
# then idle. The "k3s in Docker" requirement: the cgroup ROOT must have no processes of its own
# (move them to a leaf) and must delegate its controllers to the subtree, so kubelet can create
# /sys/fs/cgroup/kubepods underneath it.
set -eu
if [ -f /sys/fs/cgroup/cgroup.controllers ]; then
  mkdir -p /sys/fs/cgroup/init
  # Move every process out of the cgroup root into the `init` leaf.
  while read -r pid; do echo "$pid" > /sys/fs/cgroup/init/cgroup.procs 2>/dev/null || true; done < /sys/fs/cgroup/cgroup.procs
  # Delegate every available controller to the root's children.
  for c in $(cat /sys/fs/cgroup/cgroup.controllers); do echo "+$c" > /sys/fs/cgroup/cgroup.subtree_control 2>/dev/null || true; done
fi
exec sleep infinity
