// A model adapter process that fails at load: it says why on stderr and exits before it is ready.
process.stderr.write("cannot load the adapter: a module is missing\n");
process.exit(3);
