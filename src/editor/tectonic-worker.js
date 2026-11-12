'use strict';

import { verifiedTectonicResponse } from './tectonic-resource';

var TECTONIC_REVISION = 'eaf26222821d7254df1d28c78a1f7897b309b727';
var TECTONIC_ROOT = 'https://raw.githubusercontent.com/nl5887/tectonic-wasm/' + TECTONIC_REVISION + '/output/';
var wasmExports;
var outputLog = '';
var textDecoder = new TextDecoder();
var textEncoder = new TextEncoder();

function log(text) {
  outputLog = (outputLog + text).slice(-20000);
}

function writeU32(pointer, value) {
  new DataView(wasmExports.memory.buffer).setUint32(pointer, value, true);
}

function wasiImports() {
  var wasi = {};
    wasi.args_sizes_get = function (count, size) {
      writeU32(count, 0);
      writeU32(size, 0);
      return 0;
    };
    wasi.args_get = function () { return 0; };
    wasi.environ_sizes_get = wasi.args_sizes_get;
    wasi.environ_get = function () { return 0; };
    wasi.proc_exit = function (code) { throw new Error('Tectonic exited with code ' + code); };
    wasi.fd_close = function () { return 0; };
    wasi.fd_read = function (fd, iovecs, count, readPointer) {
      writeU32(readPointer, 0);
      return 0;
    };
    wasi.fd_seek = function (fd, offset, whence, resultPointer) {
      new DataView(wasmExports.memory.buffer).setBigInt64(resultPointer, 0n, true);
      return 0;
    };
    wasi.fd_write = function (fd, iovecs, count, writtenPointer) {
      var view = new DataView(wasmExports.memory.buffer);
      var written = 0;
      for (var index = 0; index < count; index++) {
        var entry = iovecs + index * 8;
        var pointer = view.getUint32(entry, true);
        var length = view.getUint32(entry + 4, true);
        if (fd === 1 || fd === 2) {
          log(textDecoder.decode(new Uint8Array(wasmExports.memory.buffer, pointer, length)));
        }
        written += length;
      }
      writeU32(writtenPointer, written);
      return 0;
    };
    wasi.fd_open = function (dirfd, dirFlags, pathPointer, pathLen, oflags, fsRightsBase, fsRightsInheriting, fdFlags, resultPointer) {
      writeU32(resultPointer, 3);
      return 0;
    };
    wasi.fd_fdstat_get = function (fd, resultPointer) {
      var view = new DataView(wasmExports.memory.buffer);
      view.setUint8(resultPointer, 0);
      view.setUint8(resultPointer + 1, 0);
      for (var p = 2; p < 8; p++) view.setUint8(resultPointer + p, 0);
      view.setBigUint64(resultPointer + 8, 0n, true);
      view.setBigUint64(resultPointer + 16, 0n, true);
      return 0;
    };
    wasi.fd_prestat_get = function (fd, resultPointer) {
      var view = new DataView(wasmExports.memory.buffer);
      view.setUint8(resultPointer, 0);
      view.setUint8(resultPointer + 1, 0);
      view.setUint8(resultPointer + 2, 0);
      view.setUint8(resultPointer + 3, 0);
      view.setUint32(resultPointer + 4, 0, true);
      return 0;
    };
    wasi.fd_prestat_dir_name = function () { return 0; };
    wasi.path_open = function (dirfd, dirFlags, pathPointer, pathLen, oflags, fsRightsBase, fsRightsInheriting, fdFlags, resultPointer) {
      writeU32(resultPointer, 4);
      return 0;
    };
    wasi.fd_filestat_get = function (fd, resultPointer) {
      var view = new DataView(wasmExports.memory.buffer);
      for (var p = 0; p < 56; p++) view.setUint8(resultPointer + p, 0);
      return 0;
    };
    wasi.fd_allocate = function () { return 0; };
    wasi.fd_sync = function () { return 0; };
    wasi.fd_tell = function (fd, resultPointer) {
      writeU32(resultPointer, 0);
      return 0;
    };
    wasi.path_filestat_get = function () { return 0; };
    wasi.clock_time_get = function (clock, precision, resultPointer) {
      new DataView(wasmExports.memory.buffer).setBigUint64(resultPointer, BigInt(Date.now()) * 1000000n, true);
      return 0;
    };
    wasi.random_get = function (pointer, length) {
      var bytes = new Uint8Array(wasmExports.memory.buffer, pointer, length);
      for (var offset = 0; offset < length; offset += 65536) {
        crypto.getRandomValues(bytes.subarray(offset, Math.min(offset + 65536, length)));
      }
      return 0;
    };
    return wasi;
  }

function envImports() {
  var env = {};
  ['invoke_iiiiiiiiiiji', 'invoke_iiij', 'invoke_iii', 'invoke_iiiii', 'invoke_iiii', 'invoke_vii'].forEach(function (name) {
    env[name] = function () {
      var args = Array.prototype.slice.call(arguments);
      try {
        return wasmExports.__indirect_function_table.get(args.shift()).apply(null, args);
      } catch (error) {
        if (error && error.longjmp) {
          wasmExports.setThrew(1, error.value);
          return 0;
        }
        throw error;
      }
    };
  });
  env.emscripten_longjmp = function (buffer, value) {
    var error = new Error('Tectonic longjmp');
    error.longjmp = true;
    error.value = value;
    throw error;
  };
  env.hb_graphite2_face_get_gr_face = function () { return 0; };
  env.__main_argc_argv = function () { return 0; };
  env.emscripten_notify_memory_growth = function () {};
  env.__syscall_getcwd = function () { return 0; };
  env.__syscall_unlinkat = function () { return 0; };
  env.__syscall_rmdir = function () { return 0; };
  return env;
}

function allocate(bytes) {
  var pointer = wasmExports.malloc(Math.max(bytes.length, 1));
  if (!pointer) throw new Error('Tectonic could not allocate WebAssembly memory.');
  new Uint8Array(wasmExports.memory.buffer, pointer, bytes.length).set(bytes);
  return pointer;
}

function addFile(name, bytes) {
  var nameBytes = textEncoder.encode(name);
  var namePointer = allocate(nameBytes);
  var dataPointer = allocate(bytes);
  try {
    wasmExports.tectonic_add_file(namePointer, nameBytes.length, dataPointer, bytes.length);
  } finally {
    wasmExports.free(dataPointer);
    wasmExports.free(namePointer);
  }
}

async function fetchResource(url, expectedSha256) {
  var primaryError;
  try {
    var response = await fetch(url);
    return await verifiedTectonicResponse(response, url, expectedSha256);
  } catch (error) {
    primaryError = error;
  }
  if (url.indexOf('cdn.jsdelivr.net') !== -1 && !(primaryError && primaryError.integrityFailure)) {
    var fallback = url.replace('https://cdn.jsdelivr.net/gh/nl5887/tectonic-wasm@' + TECTONIC_REVISION + '/output/', 'https://raw.githubusercontent.com/nl5887/tectonic-wasm/' + TECTONIC_REVISION + '/output/');
    try {
      return await verifiedTectonicResponse(await fetch(fallback), fallback, expectedSha256);
    } catch (fallbackError) {
      if (fallbackError && fallbackError.integrityFailure) throw fallbackError;
    }
  }
  throw new Error('Could not download ' + url + (primaryError && primaryError.message ? ': ' + primaryError.message : ''));
}

var SUPPLEMENTAL_BUNDLE = 'H4sIAAAAAAACCuy925rbRpIg/CpplWskeVSlIkuyrfpcGsi21JZbkr06zPT+glxOAkkSFgjAAFgHYVFvsA+xl3OxV/sI/WL/F3mMPABkSXK3PWN9NosEIiMjT5GREZER3bVZTd9leUaL/TydXzu6Fsc/1uVplrLmCS0Wa7pgXVXW7XrBmj4uiPz3enowndw++OL2wT1yOtmftuRHDrRmDSPNuoIiZF6XK9IuGZnRGctJc9G0bPUmLuL4STp/XGRtHH+zrmtWtD9UbVYWXUL538Z53kORbH4ex3mkaInjaF2kbJ4VLAWyHACgwwVBQKLRPoAHktEiBAVwUVFWtG1ZXTSdaXyPQWiaphnNWdJi0g9MXSxvGC6Qs9ZuJKZDl5pnqjm4/EhpBS4K4mLBQqgLC1VMfbLzihYpnbesll2VNAVdMZJHzqjFMStS8TKOa5bTc1k5xsBr3woDIlETk7J5HM9medSyVUW7Co+CpM5BqIEFLbx69WwWxxFbVe0Fb2euWh+sRC6GLSoZq8YdC6uqWScGr/cHgVc6gC+C7krZfHAxdbtWdVXN5jRhUKr7sYYn12mSlb0NVbM5h3jO5jBsP7EiyWjjANFZ09Y0aSVks165aGbZjL/8OpvlWbmo6TyjDkiypBUsKgD7hlZxfL2L46xv17mLjFYVK9LsnIM+qDhVaZYwF2FZtKxoG4ERfsTx9XXqYsuzpp1ni3UtuuJJ1rSUpIw8gmdeUwG6pbPcAX4JjM4DzoqUCSrj+PrjEI2oYlGf895UJWpwXle0Fp3+I61bFzcrklx0UcHO3VYnieyWFUni+HpZZZS42JeMpm2p8Pt1L+TkgZmzyAoXoGHi/Smr3QHMm1K9Ii1dzeL4Olu5+OuyFHPvW7YqC5hhcZx0SR/Hl9RtziIvm4bWFxz+L/ADiKrNdO6dRZJSmA6jC6QtU3rRxXGxXs1g7qf0Io6biiaMpEx+gyWZUNhyVmXRLuO4rBVb/oUWLKtLeETm7JTV+teK1qIl4ied1bAl8ReZePTLuliWFrJ1vpTQi7JpxdeGtWw1k0jLdbtW34vy1LxI2Tv+Y9ffR+C71yDV3AtG6763WSJm4YW/1V2Zn/9h+JaNhig2BnXPs8RD/NvyshfrlTO7/ymsjDxnq6xpstPy98bUFEOrfK710XjaL3SYqf1C/+Rqv3uuJiSqSpx5lhfVkhWrrGg6r//iuD2L4rhd1lEk5MsiazPasogmbXbKomRJ6y6+xt/poWDnbU2bALJcnq6aZVm3S1qkjREte0/SpmkK/SI5axAp4q5irIWIyImjLQPKOF6JqigFFlVpJ8BT5hVIWZLTmkWaUkNoF1/7qle1tey8LesVbZddHC/WWZ6zVdnmbN5Ce1ez8tx7vk0F9zdUUGeLZbAG8WKbKvageFHOakbf7sluy/PyTEyHZgsM8TVAsWzeZlUcv4vgb4/mVVKuVrRIeRPKukrnTVtnxeL19E23M9kC/f/CfYAQdE6npFmT1AxmA60vur2+A6resrrYPzhkq77v+H8fa3YB144aesrieO9jIeXMaa8DPmoGINiw3oZR4zwHvpB2n/4EM4K2y3pFyv5T6yW13lL5lh/SBFtJ1S8q4PnrdB7NsyJrlm4jRDOyolq3125dY8Uiz5rlsDZFAtjKlMkXtw8+v33wOTk93D+syUMB8/6alNAOgLQokoZBJcqrvw5AWAqSrA1CIBi6YnWWDOtQVHUvBqtzIBNa0HRQKWPXvYZdNR8FRuAFO3vHaM5X6TC4q/h56A3mkPZHtvDAJ8BWAnnKIN01Fo0eFrPtjeENYUUdVYzhDGEM4dNjVAzh8jGF8JhZUYTQDGrPcNPU/NtWd4bKqvm9WXeGaf4rojmgtBlcNtstPXtKaVSGhCAcQmlBBhuDkAYbY06BsoCFXXea0+ohRrANC3CbY3Btbg2GteaT35xtCFFNfjEwx4IjPsSz3HYZOIzU7chBr';

var supplementalFiles = {};

async function unpackSupplementalFiles() {
  if (Object.keys(supplementalFiles).length > 0) return;
  try {
    var binary = Uint8Array.from(atob(SUPPLEMENTAL_BUNDLE), function (c) { return c.charCodeAt(0); });
    var ds = new DecompressionStream('gzip');
    var jsonText = await new Response(new Blob([binary]).stream().pipeThrough(ds)).text();
    supplementalFiles = JSON.parse(jsonText);
  } catch (error) {
    supplementalFiles = {};
  }
  Object.keys(supplementalFiles).forEach(function (name) {
    var bytes = textEncoder.encode(supplementalFiles[name]);
    addFile(name, bytes);
    if (name.endsWith('.clo')) {
      addFile('tex/latex/base/' + name, bytes);
      addFile('tex/latex/beamer/' + name, bytes);
    } else if (name.endsWith('.sty')) {
      addFile('tex/latex/tools/' + name, bytes);
      addFile('tex/latex/' + name.replace(/\.sty$/, '') + '/' + name, bytes);
    } else if (name.endsWith('.fd')) {
      addFile('tex/latex/base/' + name, bytes);
      addFile('tex/latex/amsfonts/' + name, bytes);
    } else if (name.endsWith('.ldf')) {
      addFile('tex/generic/babel/' + name, bytes);
      addFile('tex/generic/babel-portuges/' + name, bytes);
      addFile('tex/generic/babel-english/' + name, bytes);
      addFile('tex/generic/babel-spanish/' + name, bytes);
    }
  });
}

async function initialize() {
  if (wasmExports) return;
  if (typeof DecompressionStream !== 'function') {
    throw new Error('This browser does not support gzip decompression required by Tectonic.');
  }
  self.postMessage({ type: 'progress', key: 'editor.loadingEngine' });
  var responses = await Promise.all([
    fetchResource(TECTONIC_ROOT + 'tectonic_wasm.wasm'),
    fetchResource(TECTONIC_ROOT + 'tectonic-bundle.tar.gz')
  ]);
  var module = await WebAssembly.compile(await responses[0].arrayBuffer());
  var result = await WebAssembly.instantiate(module, {
    env: envImports(),
    wasi_snapshot_preview1: wasiImports()
  });
  wasmExports = result.exports;
  if (wasmExports.tectonic_wasm_version() < 1) {
    throw new Error('The downloaded Tectonic WebAssembly engine has an invalid version.');
  }
  await addTarFilesFromResponse(responses[1]);
  await unpackSupplementalFiles();

  var tulmssFallback = '\\ProvidesFile{tulmss.fd}[2021/07/23 v1.8a Latin Modern Sans mapped to Roman]\n' +
    '\\DeclareFontFamily{TU}{lmss}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{n}{<->sub*lmr/m/n}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{it}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{sl}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{it}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{sl}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{b}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\endinput';
  var tulmssData = textEncoder.encode(tulmssFallback);
  addFile('tulmss.fd', tulmssData);
  addFile('tex/latex/lm/tulmss.fd', tulmssData);

  var tulmttFallback = '\\ProvidesFile{tulmtt.fd}[2021/07/23 v1.8a Latin Modern Typewriter mapped to Roman]\n' +
    '\\DeclareFontFamily{TU}{lmtt}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{m}{n}{<->sub*lmr/m/n}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{m}{it}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{m}{sl}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{bx}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{bx}{it}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{bx}{sl}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmtt}{b}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\endinput';
  var tulmttData = textEncoder.encode(tulmttFallback);
  addFile('tulmtt.fd', tulmttData);
  addFile('tex/latex/lm/tulmtt.fd', tulmttData);

  wasmExports.tectonic_create_format();
  var format = readOutput('xelatex.fmt');
  if (!format.length) {
    throw new Error('Tectonic could not prepare its XeLaTeX format.');
  }
  addFile('latex.fmt', format);
}

function addTarFiles(bytes) {
  var entries = 0;
  var offset = 0;
  while (offset + 512 <= bytes.length) {
    var header = bytes.subarray(offset, offset + 512);
    if (header.every(function (byte) { return byte === 0; })) break;
    var name = textDecoder.decode(header.subarray(0, 100)).replace(/\0.*$/, '');
    var prefix = textDecoder.decode(header.subarray(345, 500)).replace(/\0.*$/, '');
    if (prefix) name = prefix + '/' + name;
    name = name.replace(/^\.\/+/, '');
    var sizeText = textDecoder.decode(header.subarray(124, 136)).replace(/\0/g, '').trim();
    var size = sizeText ? parseInt(sizeText, 8) : 0;
    var type = header[156];
    var contentStart = offset + 512;
    if ((type === 48 || type === 0) && name && name !== 'latex.fmt' && size >= 0 && contentStart + size <= bytes.length) {
      addFile(name, bytes.subarray(contentStart, contentStart + size));
      if (name.indexOf('lmroman') !== -1 && name.endsWith('.otf')) {
        var fileData = bytes.subarray(contentStart, contentStart + size);
        var sansName = name.replace('lmroman', 'lmsans');
        addFile(sansName, fileData);
        var monoName = name.replace('lmroman', 'lmmono');
        addFile(monoName, fileData);
        if (name === 'lmroman10-regular.otf') {
          [
            'lmroman5-regular.otf', 'lmroman6-regular.otf', 'lmroman7-regular.otf', 'lmroman8-regular.otf', 'lmroman9-regular.otf',
            'lmromanslant8-regular.otf', 'lmromanslant9-regular.otf', 'lmromanslant10-regular.otf', 'lmromanslant12-regular.otf', 'lmromanslant17-regular.otf',
            'lmromancaps10-regular.otf', 'lmromanunsl10-regular.otf', 'lmromandemi10-regular.otf',
            'lmsans8-regular.otf', 'lmsans9-regular.otf', 'lmsans10-regular.otf', 'lmsans12-regular.otf', 'lmsans17-regular.otf',
            'lmsansdemicond10-regular.otf',
            'lmmono10-regular.otf', 'lmmono8-regular.otf', 'lmmono9-regular.otf', 'lmmono12-regular.otf',
            'lmmonoslant10-regular.otf', 'lmmonolt10-regular.otf', 'lmmonoltcond10-regular.otf'
          ].forEach(function (s) { addFile(s, fileData); });
        }
        if (name === 'lmroman10-bold.otf') {
          [
            'lmroman5-bold.otf', 'lmroman6-bold.otf', 'lmroman7-bold.otf', 'lmroman8-bold.otf', 'lmroman9-bold.otf',
            'lmromanslant10-bold.otf',
            'lmsans10-bold.otf', 'lmsans12-bold.otf',
            'lmmono10-bold.otf', 'lmmonolt10-bold.otf'
          ].forEach(function (s) { addFile(s, fileData); });
        }
        if (name === 'lmroman10-italic.otf') {
          [
            'lmroman8-italic.otf', 'lmroman9-italic.otf', 'lmroman12-italic.otf',
            'lmromancaps10-oblique.otf', 'lmromandemi10-oblique.otf',
            'lmsans8-oblique.otf', 'lmsans9-oblique.otf', 'lmsans10-oblique.otf', 'lmsans12-oblique.otf', 'lmsans17-oblique.otf',
            'lmsansdemicond10-oblique.otf',
            'lmmono10-italic.otf', 'lmmonolt10-oblique.otf', 'lmmono10-oblique.otf'
          ].forEach(function (s) { addFile(s, fileData); });
        }
        if (name === 'lmroman10-bolditalic.otf') {
          ['lmsans10-boldoblique.otf', 'lmmonolt10-boldoblique.otf'].forEach(function (s) { addFile(s, fileData); });
        }
      }
      if (name.toLowerCase().endsWith('.tfm')) {
        var tfmData = bytes.subarray(contentStart, contentStart + size);
        var noExt = name.replace(/\.tfm$/i, '');
        addFile(noExt, tfmData);
        var baseNoExt = noExt.split('/').pop();
        if (baseNoExt !== noExt) addFile(baseNoExt, tfmData);
        var lower = name.toLowerCase();
        var family = lower.startsWith('ms') ? 'amsfonts' : 'cm';
        var base = 'fonts/tfm/public/' + family + '/' + name;
        var tfmPaths = [
          name,
          base,
          'fonts/tfm/' + family + '/' + name,
          'tfm/' + family + '/' + name,
          'fonts/tfm/' + name,
          'texmf-dist/' + base,
          'texmf-dist/fonts/tfm/' + family + '/' + name,
          'texmf/fonts/tfm/' + family + '/' + name,
          'texmf/fonts/tfm/public/' + family + '/' + name,
          'share/texmf/fonts/tfm/' + family + '/' + name,
          'share/texmf-dist/fonts/tfm/' + family + '/' + name
        ];
        tfmPaths.forEach(function (path) {
          if (path !== name) addFile(path, bytes.subarray(contentStart, contentStart + size));
        });
        if (lower.startsWith('cm') && lower.endsWith('.tfm')) {
          var baseName = lower.replace(/^cm/, '');
          if (baseName.startsWith('r')) {
            var cmssName = 'cmss' + baseName.slice(1);
            var cmssNoExt = cmssName.replace(/\.tfm$/i, '');
            addFile(cmssNoExt, tfmData);
            tfmPaths.forEach(function (path) {
              var cmssPath = path.replace(/cmr(\d+\.tfm)$/, 'cmss$1').replace(/cmr(\d+\.tfm)$/, 'cmss$1');
              if (cmssPath !== path && cmssPath !== name) addFile(cmssPath, bytes.subarray(contentStart, contentStart + size));
            });
          }
          if (baseName.startsWith('r')) {
            var m = lower.match(/^cmr(\d+)\.tfm$/);
            if (m) {
              var decipoints = parseInt(m[1], 10) * 100;
              var ecrmName = 'ecrm' + decipoints;
              addFile(ecrmName, tfmData);
              tfmPaths.forEach(function (path) {
                var ecrmPath = path.replace(/cmr(\d+\.tfm)$/, 'ecrm' + decipoints + '.tfm');
                if (ecrmPath !== path && ecrmPath !== name) addFile(ecrmPath, bytes.subarray(contentStart, contentStart + size));
              });
            }
          }
          if (lower === 'cmr8.tfm') {
            addFile('cmr9', tfmData);
            addFile('cmr9.tfm', tfmData);
          } else if (lower === 'cmr12.tfm') {
            addFile('cmr17', tfmData);
            addFile('cmr17.tfm', tfmData);
          } else if (lower === 'cmmi8.tfm') {
            addFile('cmmi9', tfmData);
            addFile('cmmi9.tfm', tfmData);
          } else if (lower === 'cmsy8.tfm') {
            addFile('cmsy9', tfmData);
            addFile('cmsy9.tfm', tfmData);
          } else if (lower === 'cmex8.tfm') {
            addFile('cmex9', tfmData);
            addFile('cmex9.tfm', tfmData);
          }
          if (baseName.startsWith('r')) {
            var cmttName = 'cmtt' + baseName.slice(1);
            var cmttNoExt = cmttName.replace(/\.tfm$/i, '');
            addFile(cmttNoExt, tfmData);
            tfmPaths.forEach(function (path) {
              var cmttPath = path.replace(/cmr(\d+\.tfm)$/, 'cmtt$1').replace(/cmr(\d+\.tfm)$/, 'cmtt$1');
              if (cmttPath !== path && cmttPath !== name) addFile(cmttPath, bytes.subarray(contentStart, contentStart + size));
            });
          }
          if (baseName.startsWith('r')) {
            var m = lower.match(/^cmr(\d+)\.tfm$/);
            if (m) {
              var fontPt = m[1];
              var lmssName = 'lmss' + fontPt;
              addFile(lmssName, tfmData);
              tfmPaths.forEach(function (path) {
                var lmssPath = path.replace(/cmr(\d+\.tfm)$/, 'lmss' + fontPt + '.tfm');
                if (lmssPath !== path && lmssPath !== name) addFile(lmssPath, bytes.subarray(contentStart, contentStart + size));
              });
            }
          }
        }
      }
      entries++;
    }
    offset = contentStart + Math.ceil(size / 512) * 512;
  }
  if (!entries) throw new Error('The Tectonic package bundle is empty or invalid.');
}

async function addTarFilesFromResponse(response) {
  var archive = await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
  addTarFiles(new Uint8Array(archive));
}

var BEAMER_GITHUB_ROOT = 'https://raw.githubusercontent.com/josephwright/beamer/master/base/';
var BEAMER_GITHUB_FILES = [
  'beamer.cls',
  'beamerbaseauxtemplates.sty',
  'beamerbaseboxes.sty',
  'beamerbasecolor.sty',
  'beamerbasecompatibility.sty',
  'beamerbasedecode.sty',
  'beamerbasefont.sty',
  'beamerbaseframe.sty',
  'beamerbaseframecomponents.sty',
  'beamerbaseframesize.sty',
  'beamerbaselocalstructure.sty',
  'beamerbasemisc.sty',
  'beamerbasemodes.sty',
  'beamerbasenavigation.sty',
  'beamerbasenavigationsymbols.tex',
  'beamerbasenotes.sty',
  'beamerbaseoptions.sty',
  'beamerbaseoverlay.sty',
  'beamerbaserequires.sty',
  'beamerbasearticle.sty',
  'beamerbasesection.sty',
  'beamerbasetemplates.sty',
  'beamerbasethemes.sty',
  'beamerbasetheorems.sty',
  'beamerbasetitle.sty',
  'beamerbasetoc.sty',
  'beamerbasetranslator.sty',
  'beamerbasetwoscreens.sty',
  'beamerbaseverbatim.sty'
];
var BEAMER_DEFAULT_THEME_FILES = [
  'themes/outer/beamerouterthemedefault.sty',
  'themes/inner/beamerinnerthemedefault.sty',
  'themes/color/beamercolorthemedefault.sty',
  'themes/font/beamerfontthemedefault.sty',
  'themes/font/beamerfontthemeserif.sty',
  'themes/theme/beamerthemedefault.sty'
];
var BEAMER_MADRID_THEME_FILES = [
  'themes/theme/beamerthemeMadrid.sty',
  'themes/color/beamercolorthemewhale.sty',
  'themes/color/beamercolorthemeorchid.sty',
  'themes/inner/beamerinnerthemerounded.sty',
  'themes/outer/beamerouterthemeinfolines.sty'
];
var XXCOLOR_URL = 'https://raw.githubusercontent.com/pgf-tikz/pgf/master/tex/latex/pgf/utilities/xxcolor.sty';
var TRANSLATOR_GITHUB_ROOT = 'https://raw.githubusercontent.com/josephwright/translator/master/';
var TRANSLATOR_FILES = [
  'translator.sty',
  'dictionaries/translator-basic-dictionary.sty',
  'dictionaries/translator-bibliography-dictionary.sty',
  'dictionaries/translator-environment-dictionary.sty',
  'dictionaries/translator-months-dictionary.sty',
  'dictionaries/translator-numbers-dictionary.sty',
  'dictionaries/translator-theorem-dictionary.sty'
];

async function fetchBeamerFiles() {
  var allFiles = BEAMER_GITHUB_FILES
    .concat(BEAMER_DEFAULT_THEME_FILES)
    .concat(BEAMER_MADRID_THEME_FILES);
  for (var i = 0; i < allFiles.length; i++) {
    var name = allFiles[i];
    try {
      var response = await fetchResource(BEAMER_GITHUB_ROOT + name);
      var bytes = await response.arrayBuffer();
      var u8 = new Uint8Array(bytes);
      addFile(name, u8);
      var baseName = name.split('/').pop();
      if (baseName !== name) {
        addFile(baseName, u8);
        addFile('tex/latex/beamer/' + baseName, u8);
      }
      addFile('tex/latex/beamer/' + name, u8);
    } catch (error) {
    }
  }
  for (var i = 0; i < TRANSLATOR_FILES.length; i++) {
    var name = TRANSLATOR_FILES[i];
    try {
      var response = await fetchResource(TRANSLATOR_GITHUB_ROOT + name);
      var bytes = await response.arrayBuffer();
      var u8 = new Uint8Array(bytes);
      addFile(name, u8);
      var baseName = name.split('/').pop();
      if (baseName !== name) {
        addFile(baseName, u8);
        addFile('tex/latex/translator/' + baseName, u8);
      }
      addFile('tex/latex/translator/' + name, u8);
    } catch (error) {
    }
  }
  addFile('enumerate.sty', new TextEncoder().encode('\\ProvidesPackage{enumerate}[2000/08/01]\\endinput'));
  addFile('tex/latex/enumerate/enumerate.sty', new TextEncoder().encode('\\ProvidesPackage{enumerate}[2000/08/01]\\endinput'));
  var amsStub = new TextEncoder().encode('\\ProvidesPackage{amssymb}[2013/01/14 v3.01]\\endinput');
  addFile('amssymb.sty', amsStub);
  addFile('tex/latex/amssymb/amssymb.sty', amsStub);
  var amsFontsStub = new TextEncoder().encode('\\ProvidesPackage{amsfonts}[2013/01/14 v3.01]\\endinput');
  addFile('amsfonts.sty', amsFontsStub);
  addFile('tex/latex/amsfonts/amsfonts.sty', amsFontsStub);
  var tulmssFallback = '\\ProvidesFile{tulmss.fd}[2021/07/23 v1.8a Latin Modern Sans mapped to Roman]\n' +
    '\\DeclareFontFamily{TU}{lmss}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{n}{<->sub*lmr/m/n}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{it}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{m}{sl}{<->sub*lmr/m/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{it}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{bx}{sl}{<->sub*lmr/bx/it}{}\n' +
    '\\DeclareFontShape{TU}{lmss}{b}{n}{<->sub*lmr/bx/n}{}\n' +
    '\\endinput';
  var tulmssData = new TextEncoder().encode(tulmssFallback);
  addFile('tulmss.fd', tulmssData);
  addFile('tex/latex/lm/tulmss.fd', tulmssData);
  try {
    var response = await fetchResource(XXCOLOR_URL);
    var bytes = await response.arrayBuffer();
    addFile('xxcolor.sty', new Uint8Array(bytes));
    addFile('tex/latex/beamer/xxcolor.sty', new Uint8Array(bytes));
  } catch (error) {
  }
}

function sourceUsesBeamer(sourceText) {
  return /\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(sourceText);
}

function readOutput(name) {
  var nameBytes = textEncoder.encode(name);
  var namePointer = allocate(nameBytes);
  try {
    var size = wasmExports.tectonic_get_output_size(namePointer, nameBytes.length);
    if (!size) return new Uint8Array(0);
    var outputPointer = wasmExports.malloc(size);
    if (!outputPointer) throw new Error('Tectonic could not allocate output memory.');
    try {
      var copied = wasmExports.tectonic_get_output(namePointer, nameBytes.length, outputPointer, size);
      return new Uint8Array(wasmExports.memory.buffer, outputPointer, copied).slice();
    } finally {
      wasmExports.free(outputPointer);
    }
  } finally {
    wasmExports.free(namePointer);
  }
}

function stripBeamerPackages(source) {
  ['inputenc', 'fontenc', 'babel', 'amsfonts', 'amssymb'].forEach(function (pkg) {
    source = removePackage(source, pkg);
  });
  return source;
}

function stripMathPackages(source) {
  return stripFontDependentPackages(source);
}

function removePackage(source, packageName) {
  return source.replace(/\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{([^}]*)\}/g, function (match, list) {
    var tokens = list.split(',').map(function (t) { return t.trim(); }).filter(Boolean);
    var kept = tokens.filter(function (t) { return t !== packageName; });
    if (kept.length === 0) return '';
    return match.replace(list, kept.join(','));
  });
}

var FONT_DEPENDENT_PACKAGES = [
  'inputenc',
  'fontenc',
  'lmodern',
  'textcomp',
  'upgreek'
];

function stripFontDependentPackages(source) {
  return FONT_DEPENDENT_PACKAGES.reduce(removePackage, source);
}

function prepareMathSource(files, mainFile) {
  var source = files[mainFile];
  if (!source) return source;
  source = source.replace(/\\\\(\s*\[)/g, function (_, bracket) { return '\\\\\\relax' + bracket; });
  if (/\\HUGE\b/.test(source) && !/\\(?:re)?newcommand\*?\{\\HUGE\}/.test(source)) {
    source = source.replace(/\\begin\{document\}/, '\\providecommand{\\HUGE}{\\Huge}\n\\begin{document}');
  }
  if (/\\documentclass\s*(\[[^\]]*\])?\s*\{beamer\}/.test(source)) {
    return stripBeamerPackages(source);
  }
  source = stripMathPackages(source);
  var babelMatch = source.match(/\\(?:usepackage|RequirePackage)(?:\s*\[([^\]]*)\])?\s*\{[^}]*\bbabel\b[^}]*\}/);
  if (babelMatch && babelMatch[1]) {
    var langs = babelMatch[1].split(/\s*,\s*/);
    langs.forEach(function (lang) {
      lang = lang.trim();
      if (!lang || lang.indexOf('=') !== -1) return;
      var ldfName = lang + '.ldf';
      if (!supplementalFiles[ldfName]) {
        var stub = '\\ProvidesLanguage{' + lang + '}\\input{nil.ldf}\\endinput';
        var stubBytes = textEncoder.encode(stub);
        addFile(ldfName, stubBytes);
        addFile('tex/generic/babel/' + ldfName, stubBytes);
      }
    });
  }
  var projectSource = Object.keys(files).map(function (name) { return files[name]; }).join('\n');
  if (!/\$|\\\(|\\\[|\\begin\s*\{(?:equation|align(?:at)?|flalign|gather|multline|displaymath|math|eqnarray)\*?\}/.test(projectSource)) return source;
  if (/\\(?:usepackage|RequirePackage)(?:\s*\[[^\]]*\])?\s*\{[^}]*\bunicode-math\b/.test(projectSource)) return source;
  return source;
}

async function compileDocument(message) {
  outputLog = '';
  var files = message.files || {};
  Object.keys(files).forEach(function (name) {
    addFile(name, textEncoder.encode(files[name]));
  });
  var source = files[message.mainFile];
  if (typeof source !== 'string') throw new Error('The active TeX source file is missing.');
  if (sourceUsesBeamer(source)) await fetchBeamerFiles();
  source = prepareMathSource(files, message.mainFile);
  var inputBytes = textEncoder.encode(source);
  var inputPointer = allocate(inputBytes);
  var engineFailure = null;
  try {
    wasmExports.tectonic_set_input(inputPointer, inputBytes.length);
    wasmExports.tectonic_compile();
  } catch (error) {
    engineFailure = error;
  } finally {
    wasmExports.free(inputPointer);
  }
  var texLog = textDecoder.decode(readOutput('texput.log'));
  if (engineFailure) {
    var failure = new Error(engineFailure && engineFailure.message ? engineFailure.message : String(engineFailure));
    failure.log = texLog || outputLog;
    throw failure;
  }
  var pdf = readOutput('texput.pdf');
  if (pdf.length < 5 || textDecoder.decode(pdf.subarray(0, 5)) !== '%PDF-') {
    var invalid = new Error('Tectonic did not produce a valid PDF.');
    invalid.log = texLog || outputLog;
    throw invalid;
  }
  var compileLog = texLog || outputLog;
  return {
    pdf: pdf.buffer,
    log: compileLog.slice(-20000),
    errors: (function () {
      var allErrors = compileLog.match(/^!.*$/gm) || [];
      var realErrors = allErrors.filter(function (e) {
        return !/! Font .* not loadable/i.test(e) && !/! \\textfont .* is undefined/i.test(e);
      });
      return new Set(realErrors).size;
    })(),
    warnings: new Set(compileLog.match(/^LaTeX Warning:.*$/gm) || []).size
  };
}

self.addEventListener('message', async function (event) {
  var message = event.data;
  if (!message || message.type !== 'compile') return;
  try {
    await initialize();
    var result = await compileDocument(message);
    self.postMessage({
      type: 'result',
      id: message.id,
      pdf: result.pdf,
      log: result.log,
      errors: result.errors,
      warnings: result.warnings
    }, [result.pdf]);
  } catch (error) {
    self.postMessage({
      type: 'error',
      id: message.id,
      message: error && error.message ? error.message : String(error),
      log: error.log || outputLog
    });
  }
});
