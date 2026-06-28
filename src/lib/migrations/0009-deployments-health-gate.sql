-- Record the steady-state health-gate outcome per deployment (P1.8): JSON { attempts, ok, lastReason }.
ALTER TABLE deployments ADD COLUMN health_gate_result TEXT;
