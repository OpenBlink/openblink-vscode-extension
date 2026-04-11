MRuby::Build.new('emscripten') do |conf|
  toolchain :clang

  # Output directory for mrbc.js and mrbc.wasm
  conf.build_dir = File.expand_path('resources/wasm_build', __dir__)

  # Compiler settings (Emscripten 5.0.5)
  conf.cc.command = 'emcc'
  conf.cxx.command = 'em++'
  conf.linker.command = 'emcc'
  conf.archiver.command = 'emar'

  # Optimization settings
  conf.cc.flags << '-O3'
  conf.cc.flags << '-flto'
  conf.cc.flags << '-fno-exceptions'

  # WebAssembly settings — target Node.js for VS Code extension
  conf.linker.flags << '-sWASM=1'
  conf.linker.flags << '-sENVIRONMENT=node'

  # Module settings — MODULARIZE for safe require() loading (no eval)
  conf.linker.flags << '-sMODULARIZE=1'
  conf.linker.flags << '-sEXPORT_NAME=createMrbc'
  conf.linker.flags << '-sEXPORT_ES6=0'

  # Memory settings
  conf.linker.flags << '-sALLOW_MEMORY_GROWTH=1'
  conf.linker.flags << '-sINITIAL_MEMORY=33554432'    # 32MB
  conf.linker.flags << '-sMAXIMUM_MEMORY=268435456'   # 256MB
  conf.linker.flags << '-sSTACK_SIZE=5242880'          # 5MB
  conf.linker.flags << '-sMALLOC=emmalloc'

  # Filesystem settings — MEMFS (in-memory virtual FS, no real FS access)
  conf.linker.flags << '-sFORCE_FILESYSTEM=1'
  conf.linker.flags << '-sINVOKE_RUN=0'

  # Performance settings
  conf.linker.flags << '-sASSERTIONS=0'
  conf.linker.flags << '-sDISABLE_EXCEPTION_CATCHING=1'

  # Stability settings
  conf.linker.flags << '-sSTACK_OVERFLOW_CHECK=1'

  # Export settings
  conf.linker.flags << '-sEXPORTED_FUNCTIONS=["_main","_malloc","_free"]'
  conf.linker.flags << '-sEXPORTED_RUNTIME_METHODS=["stringToUTF8","setValue","FS"]'

  exts.executable = '.js'

  # mrbc
  conf.gem core: 'mruby-bin-mrbc'

  conf.build_mrbc_exec
  conf.disable_libmruby
  conf.disable_presym
end

# Post-build: Copy mrbc.js and mrbc.wasm to resources/wasm
MRuby.each_target do |target|
  next unless target.name == 'emscripten'

  file "#{target.build_dir}/bin/mrbc.js" do
    # This dependency is handled by mruby build system
  end

  task :all => "#{__dir__}/resources/wasm/mrbc.js"

  file "#{__dir__}/resources/wasm/mrbc.js" => "#{target.build_dir}/bin/mrbc.js" do |t|
    FileUtils.mkdir_p(File.dirname(t.name))
    FileUtils.cp("#{target.build_dir}/bin/mrbc.js", t.name)
    FileUtils.cp("#{target.build_dir}/bin/mrbc.wasm", "#{__dir__}/resources/wasm/mrbc.wasm")
    puts "Copied mrbc.js and mrbc.wasm to resources/wasm/"
  end
end
