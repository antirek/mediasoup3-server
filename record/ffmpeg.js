// Class to handle child process used for running FFmpeg

const child_process = require('child_process');
const { EventEmitter } = require('events');

const { createSdpText } = require('./sdp');
const { convertStringToStream } = require('./utils');

const RECORD_FILE_LOCATION_PATH = process.env.RECORD_FILE_LOCATION_PATH || './files';

module.exports = class FFmpeg {
  constructor (rtpParameters, peerId = '', kind = 'video') {
    this._rtpParameters = rtpParameters;
    this._process = undefined;
    this._observer = new EventEmitter();
    this.peerId = peerId;
    this.kind = kind;
    this._createProcess();
  }

  _createProcess () {
    const sdpString = createSdpText(this._rtpParameters, this.kind);
    const sdpStream = convertStringToStream(sdpString);

    console.log('createProcess() [sdpString:%s]', sdpString);

    console.log('this._commandArgs', this._commandArgs.toString());

    this._process = child_process.spawn('ffmpeg', this._commandArgs);

    if (this._process.stderr) {
      this._process.stderr.setEncoding('utf-8');

      this._process.stderr.on('data', data =>
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    if (this._process.stdout) {
      this._process.stdout.setEncoding('utf-8');

      this._process.stdout.on('data', data => 
        console.log('ffmpeg::process::data [data:%o]', data)
      );
    }

    this._process.on('message', message =>
      console.log('ffmpeg::process::message [message:%o]', message)
    );

    this._process.on('error', error =>
      console.error('ffmpeg::process::error [error:%o]', error)
    );

    this._process.once('close', () => {
      console.log('ffmpeg::process::close');
      this._observer.emit('process-close');
    });

    sdpStream.on('error', error =>
      console.error('sdpStream::error [error:%o]', error)
    );

    // Pipe sdp stream to the ffmpeg process
    sdpStream.resume();
    sdpStream.pipe(this._process.stdin);
  }

  kill () {
    console.log('kill() [pid:%d]', this._process.pid);
    this._process.kill('SIGINT');
  }

  get _commandArgs () {
    let commandArgs = [
      '-loglevel',
      'warning',
      '-protocol_whitelist',
      'pipe,udp,rtp',
      '-fflags',
      '+genpts',
      '-f',
      'sdp',
      '-i',
      'pipe:0'
    ];

    if (this.kind === 'video') {
      commandArgs = commandArgs.concat(this._videoArgs);
    } else {
      commandArgs = commandArgs.concat(this._audioArgs);
    }
    
    // commandArgs = commandArgs.concat(this._audioArgs);

    commandArgs = commandArgs.concat([
      '-flags',
      '+global_header',
      `${RECORD_FILE_LOCATION_PATH}/${this.peerId}-${this.kind}-${this._rtpParameters.fileName}.webm`
    ]);

    console.log('commandArgs:%o', commandArgs);

    return commandArgs;
  }

  get _videoArgs () {
    return [
      '-map',
      '0:v:0',
      '-c:v',
      'copy'
    ];
  }

  get _audioArgs () {
    return [
      '-map',
      '0:a:0',
      '-strict', // libvorbis is experimental
      '-2',
      '-c:a',
      'copy'
    ];
  }
}
