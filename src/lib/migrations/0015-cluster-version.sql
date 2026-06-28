-- kubectl version-skew policy (CC.5). Cache each cluster's apiserver gitVersion next to its capability
-- probe so the cluster card can flag a kubectl<->apiserver minor skew. Additive + nullable (NULL until
-- the next capability refresh runs `kubectl version -o json` against the cluster).
ALTER TABLE cluster_capabilities ADD COLUMN server_version TEXT;
