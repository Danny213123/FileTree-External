/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** "1" in the demo build (`vite --mode demo`), which answers every backend command with invented data. */
  readonly VITE_FILETREE_DEMO?: string;
}
