// Default dataset. Override per-visit with URL params, e.g.
//   http://localhost:8765/?bucket=some-other-public-bucket&name=Other&prefix=sub/dir/
// Any public S3 bucket that allows anonymous ListObjectsV2 + GET (with CORS) works.
export const DEFAULT = {
  name: "TAIR",
  bucket: "multimodal-imaging-for-cerebrovascular-disease",
  endpoint: "", // blank = https://<bucket>.s3.amazonaws.com
  prefix: "",
};
