// napi-build wires up the Node-API symbol resolution and (on Windows) the
// delay-load hook for node.exe / electron.exe so the resulting .node can be
// `require`d by the Electron main process.
fn main() {
    napi_build::setup();
}
