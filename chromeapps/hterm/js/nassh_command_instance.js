// Copyright (c) 2012 The Chromium OS Authors. All rights reserved.
// Use of this source code is governed by a BSD-style license that can be
// found in the LICENSE file.

/**
 * The NaCl-ssh-powered terminal command.
 *
 * This class defines a command that can be run in an hterm.Terminal instance.
 * This command creates an instance of the NaCl-ssh plugin and uses it to
 * communicate with an ssh daemon.
 *
 * If you want to use something other than this NaCl plugin to connect to a
 * remote host (like a shellinaboxd, etc), you'll want to create a brand new
 * command.
 *
 * @param {Object} argv The argument object passed in from the Terminal.
 */
nassh.CommandInstance = function(argv) {
  // Command arguments.
  this.argv_ = argv;

  // Command environment.
  this.environment_ = argv.environment || {};

  // hterm.Terminal.IO instance.
  this.io = null;

  // Relay manager.
  this.relay_ = null;

  // Parsed extension manifest.
  this.manifest_ = null;

  // The HTML5 persistent FileSystem instance for this extension.
  this.fileSystem_ = null;

  // An HTML5 DirectoryEntry for /.ssh/.
  this.sshDirectoryEntry_ = null;

  // Root preference manager.
  this.prefs_ = new nassh.GlobalPreferences();

  // Counters used to acknowledge writes from the plugin.
  this.stdoutAcknowledgeCount_ = 0;
  this.stderrAcknowledgeCount_ = 0;
};

/**
 * The name of this command used in messages to the user.
 *
 * Perhaps this will also be used by the user to invoke this command if we
 * build a command line shell.
 */
nassh.CommandInstance.prototype.commandName = 'nassh';

/**
 * Static run method invoked by the terminal.
 */
nassh.CommandInstance.run = function(argv) {
  return new nassh.CommandInstance(argv);
};

/**
 * Start the nassh command.
 *
 * Instance run method invoked by the nassh.CommandInstance ctor.
 */
nassh.CommandInstance.prototype.run = function() {
  this.io = this.argv_.io.push();

  // Similar to hterm.ferr, except this logs to the terminal too.
  var ferr = function(msg) {
    return function(err) {
      var ary = Array.apply(null, arguments);
      console.error(msg + ': ' + ary.join(', '), hterm.getStack());

      this.io.println(hterm.msg('UNEXPECTED_ERROR'));
      this.io.println(err);
    }.bind(this);
  }.bind(this);


  var onManifestLoaded = function(manifest) {
    this.manifest_ = manifest;

    this.io.println(
        hterm.msg('WELCOME_VERSION',
                  ['\x1b[1m' + this.manifest_.name + '\x1b[m',
                   '\x1b[1m' + this.manifest_.version + '\x1b[m']));
    this.io.println(
        hterm.msg('WELCOME_FAQ', ['\x1b[1mhttp://goo.gl/m6Nj8\x1b[m']));

    nassh.getFileSystem(onFileSystemFound, ferr('FileSystem init failed'));
  }.bind(this);

  var onFileSystemFound = function(fileSystem, sshDirectoryEntry) {
    this.fileSystem_ = fileSystem;
    this.sshDirectoryEntry_ = sshDirectoryEntry;

    var argstr = this.argv_.argString;

    // This item is set before we redirect away to login to a relay server.
    // If it's set now, it's the first time we're reloading after the redirect.
    var pendingRelay = window.sessionStorage.getItem('nassh.pendingRelay');
    window.sessionStorage.removeItem('nassh.pendingRelay');

    if (!argstr || (window.sessionStorage.getItem('nassh.promptOnReload') &&
                    !pendingRelay)) {
      // If promptOnReload is set or we haven't gotten the destination
      // as an argument then we need to ask the user for the destination.
      //
      // The promptOnReload session item allows us to remember that we've
      // displayed the dialog, so we can re-display it if the user reloads
      // the page.  (Items in sessionStorage are scoped to the tab, kept
      // between page reloads, and discarded when the tab goes away.)
      window.sessionStorage.setItem('nassh.promptOnReload', 'yes');

      this.promptForDestination_();
    } else {
      if (!this.connectToArgString(argstr)) {
        this.io.println(hterm.msg('BAD_DESTINATION', [this.argv_.argString]));
        this.exit(1);
      }
    }
  }.bind(this);

  nassh.loadManifest(onManifestLoaded, ferr('Manifest load failed'));
};

/**
 * Removes a file from the HTML5 filesystem.
 *
 * Most likely you want to remove something from the /.ssh/ directory.
 *
 * This command is only here to support unsavory JS console hacks for managing
 * the /.ssh/ directory.
 *
 * @param {string} fullPath The full path to the file to remove.
 */
nassh.CommandInstance.prototype.removeFile = function(fullPath) {
  hterm.removeFile(this.fileSystem_.root, '/.ssh/' + identityName);
};

/**
 * Removes a directory from the HTML5 filesystem.
 *
 * Most likely you'll want to remove the entire /.ssh/ directory.
 *
 * This command is only here to support unsavory JS console hacks for managing
 * the /.ssh/ directory.
 *
 * @param {string} fullPath The full path to the file to remove.
 */
nassh.CommandInstance.prototype.removeDirectory = function(fullPath) {
  this.fileSystem_.root.getDirectory(
      fullPath, {},
      function (f) {
        f.removeRecursively(hterm.flog('Removed: ' + fullPath),
                            hterm.ferr('Error removing' + fullPath));
      },
      hterm.flog('Error finding: ' + fullPath)
  );
};

/**
 * Remove all known hosts.
 *
 * This command is only here to support unsavory JS console hacks for managing
 * the /.ssh/ directory.
 */
nassh.CommandInstance.prototype.removeAllKnownHosts = function() {
  this.fileSystem_.root.getFile(
      '/.ssh/known_hosts', {create: false},
      function(fileEntry) { fileEntry.remove(function() {}) });
};

/**
 * Remove a known host by index.
 *
 * This command is only here to support unsavory JS console hacks for managing
 * the /.ssh/ directory.
 *
 * @param {integer} index One-based index of the known host entry to remove.
 */
nassh.CommandInstance.prototype.removeKnownHostByIndex = function(index) {
  var onError = hterm.flog('Error accessing /.ssh/known_hosts');
  var self = this;

  hterm.readFile(
      self.fileSystem_.root, '/.ssh/known_hosts',
      function(contents) {
        var ary = contents.split('\n');
        ary.splice(index - 1, 1);
        hterm.overwriteFile(self.fileSystem_.root, '/.ssh/known_hosts',
                            ary.join('\n'),
                            hterm.flog('done'),
                            onError);
      }, onError);
};

nassh.CommandInstance.prototype.promptForDestination_ = function(opt_default) {
  var connectDialog = this.io.createFrame(
      hterm.getURL('/html/nassh_connect_dialog.html'), null);

  connectDialog.onMessage = function(event) {
    event.data.argv.unshift(connectDialog);
    this.dispatchMessage_('connect-dialog', this.onConnectDialog_, event.data);
  }.bind(this);

  connectDialog.show();
};

nassh.CommandInstance.prototype.connectToArgString = function(argstr) {
  var ary = argstr.match(/^profile-id:([a-z0-9]+)/i);
  var rv;
  if (ary) {
    rv = this.connectToProfile(ary[1]);
  } else {
    rv = this.connectToDestination(argstr);
  }

  return rv;
};

/**
 * Initiate a connection to a remote host given a profile id.
 */
nassh.CommandInstance.prototype.connectToProfile = function(profileID) {
  var prefs = this.prefs_.getProfile(profileID);

  // We have to set the url here rather than in connectToArgString, because
  // some callers will come directly to connectToProfile.
  document.location.hash = 'profile-id:' + profileID;

  return this.connectTo({
      username: prefs.get('username'),
      hostname: prefs.get('hostname'),
      port: prefs.get('port'),
      relayHost: prefs.get('relay-host'),
      identity: prefs.get('identity'),
      argstr: prefs.get('argstr'),
      terminalProfile: prefs.get('terminal-profile')
  });
};

/**
 * Initiate a connection to a remote host given a destination string.
 *
 * @param {string} destination A string of the form username@host[:port].
 * @return {boolean} True if we were able to parse the destination string,
 *     false otherwise.
 */
nassh.CommandInstance.prototype.connectToDestination = function(destination) {
  if (destination == 'crosh') {
    document.location = 'crosh.html'
    return true;
  }

  var ary = destination.match(/^([^@]+)@([^:@]+)(?::(\d+))?(?:@(.+))?$/);
  if (!ary)
    return false;

  // We have to set the url here rather than in connectToArgString, because
  // some callers may come directly to connectToDestination.
  document.location.hash = destination;

  return this.connectTo({
      username: ary[1],
      hostname: ary[2],
      port: ary[3],
      relayHost: ary[4]
  });
};

/**
 * Initiate a connection to a remote host.
 *
 * @param {string} username The username to provide.
 * @param {string} hostname The hostname or IP address to connect to.
 * @param {string|integer} opt_port The optional port number to connect to.
 * @return {boolean} False if there was some trouble with the parameters, true
 *     otherwise.
 */
nassh.CommandInstance.prototype.connectTo = function(params) {
  if (!(params.username && params.hostname))
    return false;

  if (params.relayHost) {
    this.relay_ = new nassh.GoogleRelay(this.io, params.relayHost);
    this.io.println(hterm.msg('INITIALIZING_RELAY', [params.relayHost]));
    if (!this.relay_.init()) {
      // A false return value means we have to redirect to complete
      // initialization.  Bail out of the connect for now.  We'll resume it
      // when the relay is done with its redirect.

      // If we're going to have to redirect for the relay then we should make
      // sure not to re-prompt for the destination when we return.
      sessionStorage.setItem('nassh.pendingRelay', 'yes');
      this.relay_.redirect();
      return true;
    }
  }

  this.io.setTerminalProfile(params.terminalProfile || 'default');

  // TODO(rginda): The "port" parameter was removed from the CONNECTING message
  // on May 9, 2012, however the translations haven't caught up yet.  We should
  // remove the port parameter here once they do.
  this.io.println(hterm.msg('CONNECTING',
                            [params.username + '@' + params.hostname,
                             (params.port || '??')]));
  this.io.onVTKeystroke = this.sendString_.bind(this);
  this.io.sendString = this.sendString_.bind(this);
  this.io.onTerminalResize = this.onTerminalResize_.bind(this);

  var argv = {};
  argv.terminalWidth = this.io.terminal_.screenSize.width;
  argv.terminalHeight = this.io.terminal_.screenSize.height;
  argv.useJsSocket = !!this.relay_;
  argv.environment = this.environment_;
  argv.writeWindow = 8 * 1024;

  argv.arguments = ['-C'];  // enable compression
  var commandArgs;

  if (params.argstr) {
    var ary = params.argstr.match(/^(.*?)(?:(?:^|\s+)(?:--\s+(.*)))?$/);
    if (ary) {
      console.log(ary);
      argv.arguments = argv.arguments.concat(ary[1].split(/\s+/));
      commandArgs = ary[2] ? ary[2].split(/\s+/) : [];
    }
  }

  if (params.identity)
    argv.arguments.push('-i/.ssh/' + params.identity);
  if (params.port)
    argv.arguments.push('-p' + params.port);

  argv.arguments.push(params.username + '@' + params.hostname);
  if (commandArgs)
    argv.arguments = argv.arguments.concat(commandArgs);

  var self = this;
  this.initPlugin_(function() {
      if (!self.argv_.argString)
        self.io.println(hterm.msg('WELCOME_TIP'));

      window.onbeforeunload = self.onBeforeUnload_.bind(self);
      self.sendToPlugin_('startSession', [argv]);
    });

  document.querySelector('#terminal').focus();

  return true;
};

/**
 * Dispatch a "message" to one of a collection of message handlers.
 */
nassh.CommandInstance.prototype.dispatchMessage_ = function(
    desc, handlers, msg) {
  if (msg.name in handlers) {
    handlers[msg.name].apply(this, msg.argv);
  } else {
    console.log('Unknown "' + desc + '" message: ' + msg.name);
  }
};

nassh.CommandInstance.prototype.initPlugin_ = function(onComplete) {
  var self = this;
  function onPluginLoaded() {
    self.io.println(hterm.msg('PLUGIN_LOADING_COMPLETE'));
    onComplete();
  };

  this.io.print(hterm.msg('PLUGIN_LOADING'));

  this.plugin_ = window.document.createElement('embed');
  this.plugin_.style.cssText =
      ('position: absolute;' +
       'top: -99px' +
       'width: 0;' +
       'height: 0;');
  this.plugin_.setAttribute('src', '../plugin/ssh_client.nmf');
  this.plugin_.setAttribute('type', 'application/x-nacl');
  this.plugin_.addEventListener('load', onPluginLoaded);
  this.plugin_.addEventListener('message', this.onPluginMessage_.bind(this));

  document.body.insertBefore(this.plugin_, document.body.firstChild);
};

/**
 * Send a message to the nassh plugin.
 *
 * @param {string} name The name of the message to send.
 * @param {Array} arguments The message arguments.
 */
nassh.CommandInstance.prototype.sendToPlugin_ = function(name, arguments) {
  var str = JSON.stringify({name: name, arguments: arguments});

  this.plugin_.postMessage(str);
};

/**
 * Send a string to the remote host.
 *
 * @param {string} string The string to send.
 */
nassh.CommandInstance.prototype.sendString_ = function(string) {
  this.sendToPlugin_('onRead', [0, btoa(string)]);
};

/**
 * Notify plugin about new terminal size.
 *
 * @param {string|integer} terminal width.
 * @param {string|integer} terminal height.
 */
nassh.CommandInstance.prototype.onTerminalResize_ = function(width, height) {
  this.sendToPlugin_('onResize', [Number(width), Number(height)]);
};

/**
 * Exit the nassh command.
 */
nassh.CommandInstance.prototype.exit = function(code) {
  this.io.pop();
  window.onbeforeunload = null;

  if (this.argv_.onExit)
    this.argv_.onExit(code);
};

nassh.CommandInstance.prototype.onBeforeUnload_ = function(e) {
  var msg = hterm.msg('BEFORE_UNLOAD');
  e.returnValue = msg;
  return msg;
};

/**
 * Called when the plugin sends us a message.
 *
 * Plugin messages are JSON strings rather than arbitrary JS values.  They
 * also use "arguments" instead of "argv".  This function translates the
 * plugin message into something dispatchMessage_ can digest.
 */
nassh.CommandInstance.prototype.onPluginMessage_ = function(e) {
  var msg = JSON.parse(e.data);
  msg.argv = msg.arguments;
  this.dispatchMessage_('plugin', this.onPlugin_, msg);
};

/**
 * Connect dialog message handlers.
 */
nassh.CommandInstance.prototype.onConnectDialog_ = {};

/**
 * Sent from the dialog when the user chooses a profile.
 */
nassh.CommandInstance.prototype.onConnectDialog_.connectToProfile = function(
    dialogFrame, profileID) {
  dialogFrame.close();

  if (!this.connectToProfile(profileID))
    this.promptForDestination_();
};

/**
 * Plugin message handlers.
 */
nassh.CommandInstance.prototype.onPlugin_ = {};

/**
 * Log a message from the plugin.
 */
nassh.CommandInstance.prototype.onPlugin_.printLog = function(str) {
  console.log('plugin log: ' + str);
};

/**
 * Plugin has exited.
 */
nassh.CommandInstance.prototype.onPlugin_.exit = function(code) {
  console.log('plugin exit: ' + code);
  this.exit(code);
};

/**
 * Plugin wants to open a file.
 *
 * The plugin leans on JS to provide a persistent filesystem, which we do via
 * the HTML5 Filesystem API.
 *
 * In the future, the plugin may handle its own files.
 */
nassh.CommandInstance.prototype.onPlugin_.openFile = function(fd, path, mode) {
  var self = this;
  function onOpen(success) {
    self.sendToPlugin_('onOpenFile', [fd, success]);
  }

  if (path == '/dev/random') {
    var streamClass = nassh.Stream.Random;
    var stream = nassh.Stream.openStream(streamClass, fd, path, onOpen);
    stream.onClose = function(reason) {
      self.sendToPlugin_('onClose', [fd, reason]);
    };
  } else {
    self.sendToPlugin_('onOpenFile', [fd, false]);
  }
};

nassh.CommandInstance.prototype.onPlugin_.openSocket = function(
    fd, host, port) {
  if (!this.relay_) {
    this.sendToPlugin_('onOpenSocket', [fd, false]);
    return;
  }

  var self = this;
  var stream = this.relay_.openSocket(
      fd, host, port,
      function onOpen(success) {
        self.sendToPlugin_('onOpenSocket', [fd, success]);
      });

  stream.onDataAvailable = function(data) {
    self.sendToPlugin_('onRead', [fd, data]);
  };

  stream.onClose = function(reason) {
    console.log('close: ' + fd);
    self.sendToPlugin_('onClose', [fd, reason]);
  };
};

/**
 * Plugin wants to write some data to a file descriptor.
 *
 * This is used to write to HTML5 Filesystem files.
 */
nassh.CommandInstance.prototype.onPlugin_.write = function(fd, data) {
  var self = this;

  if (fd == 1 || fd == 2) {
    var string = atob(data);
    var ackCount = (fd == 1 ?
                    this.stdoutAcknowledgeCount_ += string.length :
                    this.stderrAcknowledgeCount_ += string.length);
    //console.log('write start: ' + ackCount);
    this.io.print(string);
    //console.log('write done.');

    setTimeout(function() {
        //console.log('ack: ' + ackCount);
        self.sendToPlugin_('onWriteAcknowledge', [fd, ackCount]);
      }, 0);
    return;
  }

  var stream = nassh.Stream.getStreamByFd(fd);
  if (!stream) {
    console.warn('Attempt to write to unknown fd: ' + fd);
    return;
  }

  stream.asyncWrite(data, function(writeCount) {
      self.sendToPlugin_('onWriteAcknowledge', [fd, writeCount]);
    }, 100);
};

/**
 * Plugin wants to read from a fd.
 */
nassh.CommandInstance.prototype.onPlugin_.read = function(fd, size) {
  var self = this;
  var stream = nassh.Stream.getStreamByFd(fd);

  if (!stream) {
    if (fd)
      console.warn('Attempt to read from unknown fd: ' + fd);
    return;
  }

  stream.asyncRead(size, function(b64bytes) {
      self.sendToPlugin_('onRead', [fd, b64bytes]);
    });
};

/**
 * Plugin wants to close a file descriptor.
 */
nassh.CommandInstance.prototype.onPlugin_.close = function(fd) {
  var self = this;
  var stream = nassh.Stream.getStreamByFd(fd);
  if (!stream) {
    console.warn('Attempt to close unknown fd: ' + fd);
    return;
  }

  stream.close();
};
