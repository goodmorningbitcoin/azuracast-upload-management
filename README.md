# AzuraCast Upload Management

Automated podcast episode uploader and management system for AzuraCast radio stations. This tool automatically downloads and uploads new podcast episodes from RSS feeds, manages episode limits, handles artwork, and maintains clean playlist organization.

## Features

- 🚀 **Automated RSS Feed Processing** - Monitors multiple podcast RSS feeds
- 📥 **Smart Episode Downloads** - Downloads audio files and artwork automatically  
- 📤 **AzuraCast Integration** - Uploads directly to your AzuraCast station
- 🎨 **Artwork Management** - Downloads and applies episode/podcast artwork
- 📋 **Playlist Assignment** - Automatically assigns episodes to playlists
- 🧹 **Orphaned File Cleanup** - Removes files not assigned to default playlist
- ⏰ **Episode Limits** - Maintains maximum episode counts per show
- 📅 **Age-based Cleanup** - Removes episodes older than specified days
- 💾 **Duplicate Prevention** - Tracks processed episodes to avoid re-uploads
- 📊 **Comprehensive Logging** - Detailed logs for monitoring and debugging

## Prerequisites

- **Node.js 16+** - [Download here](https://nodejs.org/)
- **AzuraCast Installation** - Running AzuraCast instance with API access
- **API Key** - Generated from your AzuraCast admin panel

## Installation

1. **Clone the repository:**
   ```bash
   git clone https://github.com/goodmorningbitcoin/azuracast-upload-management.git
   cd azuracast-upload-management
   ```

2. **Install dependencies:**
   ```bash
   npm install
   ```

3. **Edit your configuration:**
   Open `config.json` and replace the default values with your AzuraCast details and podcast feeds (see Configuration section below)

## Configuration

Edit `config.json` with your AzuraCast details and podcast feeds:

```json
{
  "azuraCast": {
    "host": "your-azuracast-domain.com",
    "stationId": 1,
    "defaultPlaylist": 1,
    "apiKey": "your-api-key-here"
  },
  "shows": [
    {
      "rssUrl": "https://feeds.example.com/podcast.rss",
      "maxEpisodes": 5,
      "maxAgeDays": 30,
      "playlistId": 1,
      "enabled": true
    }
  ]
}
```

### Configuration Options

#### AzuraCast Settings
- **`host`** - Your AzuraCast domain (without https://)
- **`stationId`** - Your station ID (usually 1)  
- **`defaultPlaylist`** - Main playlist ID for episode assignment
- **`apiKey`** - Your AzuraCast API key

#### Show Settings
- **`rssUrl`** - Podcast RSS feed URL
- **`maxEpisodes`** - Maximum recent episodes to keep (default: 5)
- **`maxAgeDays`** - Maximum age in days for episodes (default: 30) 
- **`playlistId`** - Playlist to assign episodes to
- **`enabled`** - Set to `false` to temporarily disable a show

## Getting Your API Key

1. Log into your AzuraCast admin panel
2. Go to **Profile** → **API Keys**
3. Click **Create New Key**
4. Copy the generated key to your `config.json`

## Usage

### Run Once
```bash
npm start
```

### Development Mode (no memory optimization)
```bash
npm run dev
```

### Check Syntax
```bash
npm test
```

### Automated Runs
Set up a cron job to run automatically:
```bash
# Run every hour
0 * * * * cd /path/to/azuracast-upload-management && npm start

# Run every 6 hours  
0 */6 * * * cd /path/to/azuracast-upload-management && npm start
```

## How It Works

1. **Orphaned File Cleanup** - Removes any files not assigned to the default playlist
2. **RSS Feed Processing** - Fetches and parses configured podcast RSS feeds
3. **Episode Filtering** - Identifies new episodes not yet processed
4. **Download & Upload** - Downloads audio files and artwork, uploads to AzuraCast
5. **Metadata Assignment** - Sets episode title, artist, album, and description
6. **Playlist Assignment** - Assigns episodes to configured playlists
7. **Cleanup** - Removes old episodes based on age and count limits

## File Structure

```
azuracast-upload-management/
├── package.json              # Dependencies and scripts
├── config.json               # Your configuration (edit with your details)
├── podcast-uploader.js       # Main application script
├── processed-episodes.json   # Tracking file (auto-created)
├── temp/                     # Temporary downloads (auto-created)
└── podcast-uploader.log      # Log file (auto-created)
```

## Troubleshooting

### Common Issues

**"API request failed"**
- Check your AzuraCast host and API key
- Ensure your AzuraCast instance is accessible
- Verify station ID is correct

**"Download failed"** 
- Check RSS feed URLs are accessible
- Verify episode enclosure URLs are valid
- Check network connectivity

**"Large file detected"**
- The script automatically handles large files
- Use `npm start` which allocates extra memory
- Files over 200MB will show warnings but should work

**"form-data module required"**
- Run `npm install` to install dependencies
- Ensure `form-data` package is installed

### Logs

Check `podcast-uploader.log` for detailed operation logs:
```bash
tail -f podcast-uploader.log
```

## Security Notes

- **Keep your API keys secure** - Don't share your configured `config.json` publicly
- Replace all default values in `config.json` with your real details
- Use environment variables for production deployments
- Regularly rotate your API keys

## Contributing

1. Fork the repository
2. Create a feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License - see the [LICENSE](LICENSE) file for details.

## Support

- **Issues**: [GitHub Issues](https://github.com/goodmorningbitcoin/azuracast-upload-management/issues)
- **Discussions**: [GitHub Discussions](https://github.com/goodmorningbitcoin/azuracast-upload-management/discussions)

## Acknowledgments

- Built for [Good Morning Bitcoin](https://goodmorningbitcoin.com)
- Powered by [AzuraCast](https://azuracast.com)
