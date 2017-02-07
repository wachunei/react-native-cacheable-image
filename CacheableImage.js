import React from 'react';
import {
  Image,
  ActivityIndicator,
  NetInfo,
  Platform,
} from 'react-native';
import RNFS, {
  DocumentDirectoryPath,
} from 'react-native-fs';
import ResponsiveImage from 'react-native-responsive-image';
import SHA1 from 'crypto-js/sha1';
import URL from 'url-parse';

export default class CacheableImage extends React.Component {
  constructor(props) {
    super(props);
    this.imageDownloadBegin = this.imageDownloadBegin.bind(this);
    this.imageDownloadProgress = this.imageDownloadProgress.bind(this);
    this.handleConnectivityChange = this.handleConnectivityChange.bind(this);
    this.stopDownload = this.stopDownload.bind(this);

    this.state = {
      isRemote: false,
      cachedImagePath: null,
      cacheable: true,
    };

    this.networkAvailable = props.networkAvailable;
    this.downloading = false;
    this.jobId = null;
  }

  componentWillMount() {
    if (this.props.checkNetwork) {
      NetInfo.isConnected.addEventListener('change', this.handleConnectivityChange);
      // componentWillUnmount unsets this.handleConnectivityChange in case the component
      // unmounts before this fetch resolves
      NetInfo.isConnected.fetch().done(this.handleConnectivityChange);
    }

    this.processSource(this.props.source, true);
  }

  componentWillReceiveProps(nextProps) {
    if (nextProps.source !== this.props.source ||
      nextProps.networkAvailable !== this.networkAvailable) {
      this.networkAvailable = nextProps.networkAvailable;
      this.processSource(nextProps.source);
    }
  }

  shouldComponentUpdate(nextProps, nextState) {
    return nextState !== this.state || nextProps !== this.props;
  }

  componentWillUnmount() {
    if (this.props.checkNetwork) {
      NetInfo.isConnected.removeEventListener('change', this.handleConnectivityChange);
      this.handleConnectivityChange = null;
    }

    if (this.downloading && this.jobId) {
      this.stopDownload();
    }
  }

  async imageDownloadBegin(info) {
    switch (info.statusCode) {
      case 404:
      case 403:
        break;
      default:
        this.downloading = true;
        this.jobId = info.jobId;
    }
  }

  async imageDownloadProgress(info) {
    if ((info.contentLength / info.bytesWritten) === 1) {
      this.downloading = false;
      this.jobId = null;
    }
  }

  async checkImageCache(imageUri, cachePath, cacheKey) {
    const dirPath = `${DocumentDirectoryPath}/${cachePath}`;
    const filePath = `${dirPath}/${cacheKey}`;

    RNFS
    .stat(filePath)
    .then((res) => {
      if (res.isFile() && res.size > 0) {
        // It's possible the component has already unmounted before setState could be called.
        // It happens when the defaultSource and source have both been cached.
        // An attempt is made to display the default however it's instantly removed
        // since source is available. Means file exists, ie, cache-hit
        this.setState({ cacheable: true, cachedImagePath: filePath });
      } else {
        throw Error('CacheableImage: Invalid file in checkImageCache()');
      }
    })
    .catch(() => {
      // means file does not exist
      // first make sure network is available..
      // if (! this.state.networkAvailable) {
      if (!this.networkAvailable) {
        return;
      }

      // then make sure directory exists.. then begin download
      // The NSURLIsExcludedFromBackupKey property can be provided to set
      // this attribute on iOS platforms.
      // Apple will reject apps for storing offline cache data that does not have this attribute.
      // https://github.com/johanneslumpe/react-native-fs#mkdirfilepath-string-options-mkdiroptions-promisevoid
      RNFS
      .mkdir(dirPath, { NSURLIsExcludedFromBackupKey: true })
      .then(() => {
        // before we change the cachedImagePath, if the previous cachedImagePath was set, remove it
        if (this.state.cacheable && this.state.cachedImagePath) {
          const delImagePath = this.state.cachedImagePath;
          this.deleteFilePath(delImagePath);
        }

        // If already downloading, cancel the job
        if (this.jobId) {
          this.stopDownload();
        }

        const downloadOptions = {
          fromUrl: imageUri,
          toFile: filePath,
          background: this.props.downloadInBackground,
          begin: this.imageDownloadBegin,
          progress: this.imageDownloadProgress,
        };

        // directory exists.. begin download
        const download = RNFS.downloadFile(downloadOptions);

        this.downloading = true;
        this.jobId = download.jobId;

        download.promise
        .then((res) => {
          this.downloading = false;
          this.jobId = null;

          switch (res.statusCode) {
            case 404:
            case 403:
              this.setState({ cacheable: false, cachedImagePath: null });
              break;
            default:
              this.setState({ cacheable: true, cachedImagePath: filePath });
          }
        })
        .catch(() => {
          // error occurred while downloading or download stopped.. remove file if created
          this.deleteFilePath(filePath);

          // If there was no in-progress job, it may have been cancelled already
          // (and this component may be unmounted)
          if (this.downloading) {
            this.downloading = false;
            this.jobId = null;
            this.setState({ cacheable: false, cachedImagePath: null });
          }
        });
      })
      .catch(() => {
        this.deleteFilePath(filePath);
        this.setState({ cacheable: false, cachedImagePath: null });
      });
    });
  }

  deleteFilePath(filePath) {
    RNFS.exists(filePath)
    .then((res) => {
      if (res) {
        RNFS.unlink(filePath).catch(f => f);
      }
    });
  }

  processSource(source, skipSourceCheck) {
    if (source !== null && source !== '' && typeof source === 'object'
        && Object.prototype.hasOwnProperty.call(source, 'uri')
        && (skipSourceCheck || typeof skipSourceCheck === 'undefined' ||
            (!skipSourceCheck && source !== this.props.source))
    ) {
       // remote
      if (this.jobId) { // sanity
        this.stopDownload();
      }
      const url = new URL(source.uri, null, true);

      // handle query params for cache key
      let cacheable = url.pathname;
      if (Array.isArray(this.props.useQueryParamsInCacheKey)) {
        this.props.useQueryParamsInCacheKey.forEach((k) => {
          if (Object.prototype.hasOwnProperty.call(url.query, k)) {
            cacheable = cacheable.concat(url.query[k]);
          }
        });
      } else if (this.props.useQueryParamsInCacheKey) {
        cacheable = cacheable.concat(url.query);
      }
      const type = url.pathname.replace(/.*\.(.*)/, '$1');
      const cacheKey = SHA1(cacheable) + (type.length < url.pathname.length ? `.${type}` : '');
      this.checkImageCache(source.uri, url.host, cacheKey);
      this.setState({ isRemote: true });
    } else {
      this.setState({ isRemote: false });
    }
  }

  stopDownload() {
    if (!this.jobId) {
      return;
    }

    this.downloading = false;
    RNFS.stopDownload(this.jobId);
    this.jobId = null;
  }

  async handleConnectivityChange(isConnected) {
    this.networkAvailable = isConnected;
  }

  renderCache() {
    const {
      children,
      defaultSource,
      checkNetwork,
      networkAvailable,
      downloadInBackground,
      activityIndicatorProps,
       ...props
     } = this.props;
    return (
      <ResponsiveImage
        source={{ uri: `file://${this.state.cachedImagePath}` }}
        {...props}
      >
        {children}
      </ResponsiveImage>
    );
  }

  renderLocal() {
    const {
      children,
      defaultSource,
      checkNetwork,
      networkAvailable,
      downloadInBackground,
      activityIndicatorProps,
      ...props
    } = this.props;
    return (
      <ResponsiveImage {...props}>
        {children}
      </ResponsiveImage>
    );
  }

  renderDefaultSource() {
    const {
      children,
      defaultSource,
      checkNetwork,
      networkAvailable,
      ...props
    } = this.props;
    return (
      <CacheableImage
        source={defaultSource}
        checkNetwork={false}
        networkAvailable={this.networkAvailable}
        {...props}
      >
        {children}
      </CacheableImage>
    );
  }

  render() {
    if (!this.state.isRemote && !this.props.defaultSource) {
      return this.renderLocal();
    }

    if (this.state.cacheable && this.state.cachedImagePath) {
      return this.renderCache();
    }

    if (this.props.defaultSource) {
      return this.renderDefaultSource();
    }

    return (
      <ActivityIndicator {...this.props.activityIndicatorProps} />
    );
  }
}

CacheableImage.propTypes = {
  activityIndicatorProps: ActivityIndicator.propTypes,
  defaultSource: Image.propTypes.source,
  source: Image.propTypes.source,
  useQueryParamsInCacheKey: React.PropTypes.oneOfType([
    React.PropTypes.bool,
    React.PropTypes.array,
  ]),
  checkNetwork: React.PropTypes.bool,
  networkAvailable: React.PropTypes.bool,
  downloadInBackground: React.PropTypes.bool,
};

CacheableImage.defaultProps = {
  style: { backgroundColor: 'transparent' },
  activityIndicatorProps: {
    style: { backgroundColor: 'transparent', flex: 1 },
  },
  useQueryParamsInCacheKey: false,
  checkNetwork: true,
  networkAvailable: false,
  downloadInBackground: (Platform.OS !== 'ios'),
};
