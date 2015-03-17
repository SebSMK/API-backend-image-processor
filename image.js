
var imagemagick = require('imagemagick-native'),
    logger = require('./logging'),
    fs = require('fs'),
    exiv = require('./public/lib/exiv2/exiv2'),
    Solr = require('./solr'),
    Q = require('q'),
    config = require('./config'),
    mmm = require('mmmagic'),
    Magic = mmm.Magic,
    addMetadata = Q.denodeify(exiv.setImageTags),
    openMetadata = Q.denodeify(exiv.getImageTags),
    deleteFile = Q.denodeify(fs.unlink),
    writeFile = Q.denodeify(fs.writeFile),
    readFile = Q.denodeify(fs.readFile);

/**
 * Helper functions
 **/

function guid() {
    function s4() {
      return Math.floor((1 + Math.random()) * 0x10000)
        .toString(16)
        .substring(1);
    }
    return s4() + s4() + '-' + s4() + '-' + s4() + '-' +
           s4() + '-' + s4() + s4() + s4();
}

function convertDanishChars(string){ 
    string = string.replace( /©/g, "Copyright" );
    string = string.replace( /Æ/g, "Ae" ); 
    string = string.replace( /Ø/g, "Oe" ); 
    string = string.replace( /Å/g, "Aa" );
    string = string.replace( /æ/g, "ae" ); 
    string = string.replace( /ø/g, "oe" ); 
    string = string.replace( /å/g, "aa" );
    return string; 
}

Image = (function() {
    
    var solr = new Solr(config.solrHost, config.solrPort);
    var magic = new Magic(mmm.MAGIC_MIME_TYPE);
    
    /**
     * Constructor
     **/
    function Image(path, width, height, scale, mode) {

        if(mode !== 'width' && mode !== 'height' && mode !== 'scale' && mode !== 'noresize'){
            throw new Error('The mode must be \'width\', \'height\' or \'scale\'');
        }
        this.path = path;
        this.width = width;
        this.height = height;
        this.scale = scale;
        this.mode = mode;
    }

    /**
     * Instance Methods 
     **/
    Image.prototype.convert = function() {

        var dpi = 72, cm, inches,
            width = 0,
            height = 0
            type = (this.type == 'image/jpeg') ? 'jpeg' : '';

        logger.info('Image.prototype.convert:', this.mode);

        if(this.mode === 'scale'){
            cm = this.width / this.scale;
            inches = cm * 0.39370;
            width = inches * dpi;
            logger.debug('scale :', this.scale);
            logger.debug('inches :', inches, 'inches');
            logger.debug('original width :', this.width, 'cm');
            logger.debug('scaled width :', cm + ' cm (' + width + ' px)');
        }else if (this.mode === 'width'){
            width = this.width;
            logger.debug('width :', this.width, 'px');
        }else if (this.mode === 'height'){
            height = this.height;
            logger.debug('height :', this.height, 'px');
        }else /* no resize */{
            return imagemagick.convert({
                srcData: this.imageData,
                density: dpi,
                format: type,
                strip: true
            });
        }
        return imagemagick.convert({
            srcData: this.imageData,
            width: width,
            height: height,
            quality: 100,
            density: dpi,
            resizeStyle: 'aspectfit',
            format: type,
            strip: true
        });
    };
    
    Image.prototype.process = function(done, error) {

        var self = this;
        self.image = config.tempFilePath + guid() + '.image';
    
        logger.info('Image.prototype.process: ' + JSON.stringify(this, null, 4));

        readFile(self.path)
        .then(function(data) { 
            logger.info('read image file', self.path);
            self.imageData = data;
            return detectFile(self.path);
            }) 
        .then(function(type) { 
            logger.info('detected file type :', type);
            self.type = type;
            return writeFile(self.image, self.imageData); 
            }) 
        .then(function() {
            logger.info('created temp copy', self.image, "(" + self.path + ")");
            return openMetadata(self.image);
            })
        .then(function(tags) { 
            logger.info('opened metadata', self.path);
            return lookupArtwork(tags, self.type); 
            })
        .then(function(newTags) {
            logger.info('finished new tags');
            logger.debug('newTags:', JSON.stringify(newTags, null, 4));
            self.imageTags = newTags;
            self.imageData = self.convert();
            return writeFile(self.image, self.imageData);
            })
        .then(function() { 
            logger.info('file conversion completed', self.image, "(" + self.path + ")");
            if(self.imageTags){
                return addMetadata(self.image, self.imageTags);
            }
            return Q.defer().resolve();/*just hit next then*/
            })
        .then(function() { 
            if(self.imageTags){
                logger.info('added new metadata', self.image,  "(" + self.path + ")");
            }
            return readFile(self.image); 
            })
        .then(function(data) { 
            logger.info('read updated data from file', self.image, "(" + self.path + ")");
            self.imageData = data;
            deleteFile(self.image).then(function(){logger.info('deleted temp copy', self.image, 
                                                   "(" + self.path + ")")}); 
            return done(self.imageData, self.type); 
            })
        .catch(function (err) {
            /*catch and break on all errors or exceptions on all the above methods*/
            logger.error('Image.prototype.process', err);
            return error(err);
            })
    }
    
    /**
     * Private methods 
     **/
    function detectFile(path) {
        
        var deferred = Q.defer();

        magic.detectFile(path, function(err, result) {
            if (err) {
                logger.error('lookup mime type FAILED');
                deferred.reject(err);
            }else{
                deferred.resolve(result);
            }
        });
        return deferred.promise;
    }

    function lookupArtwork(tags, type) {
        
        var deferred = Q.defer(),
            inventoryNum = '';
        
        if(type !== 'image/jpeg'){
            logger.info('lookupArtwork: type is not image/jpeg, returning');
            return deferred.resolve();
        }
        
        try{
            inventoryNum = tags[config.smkInventoryNumber];
        }catch(ex){
            logger.error('lookup inventoryNum FAILED');
            return deferred.resolve();
            //return deferred.reject(ex);
        }
        var encodedInventoryNum = encodeURI(inventoryNum),
            copyrightText = config.copyrightDefault,
            webStatement = config.webStatementNoRights,
            description = '',
            newTags = [],
            /* Solr should look in 'id' and 'other number'. For example: 
             * KMS8715 image uses DEP369 which is its 'other number' */
            solrPath = config.solrCore + '?q=(id%3A%22' + encodedInventoryNum + 
                      '%22)+OR+(other_numbers_andet_inventar%3A%22' +  encodedInventoryNum +
                      '%22)&fl=id%2C+title_first%2C+copyright&wt=json&indent=true';

        logger.info('lookupArtwork', solrPath);
        
        solr.get(solrPath)
        .then( function(solrResponse){
            var artwork = solrResponse.response.docs[0];
            if(artwork.copyright){
                copyrightText = convertDanishChars(artwork.copyright);
                webStatement = config.webStatementRights;
            }
            description = convertDanishChars(artwork.title_first);
            /*
             * XMP metadata should be encoded in UTF-8
             * IPTC metadata can use several encodings (provided by CodedCharacterSet)
             * EXIF metadata should be encoded in ASCII. The characters "©, æ, å and ø" 
             *      do not exist in ASCII (but do exist in some other 8bit encodings
             *      which some windows clients are using)
             * (Javascript strings are UCS2 2 byte unicode)
             * 
             * Photoshop writes UTF-8 everywhere (wrong for EXIF), and we're going to do 
             * the same. There's probably some image programs that won't show these characters
             * properly if they follow the specification exactly, but we accept that.
             * 
             * Exiv2node won't write UTF-8 to XMP. I've made a fix for this which is
             * why we're using a local version of exiv2node and not that in npm. I've
             * made a pull request to the maintainer so it should be available at some point.
             */
            newTags = {
                /*EXIF*/
                'Exif.Image.Artist' : config.attribution,
                'Exif.Image.Copyright' : copyrightText,
                'Exif.Image.ImageDescription' : description, 
                /*IPTC*/
                'Iptc.Application2.RecordVersion' : '4',/*2 bytes*/
                'Iptc.Application2.Headline' : inventoryNum, /*256 bytes*/
                'Iptc.Application2.City' : config.city, /*32 bytes*/
                'Iptc.Application2.CountryName' : config.country, /*64 bytes*/
                'Iptc.Application2.Byline' : config.attribution, /*32 bytes*/
                'Iptc.Application2.BylineTitle' : config.photo, /*32 bytes*/
                'Iptc.Application2.Credit' : config.smk, /*32 bytes*/
                'Iptc.Application2.ObjectName' : inventoryNum, /*64 bytes*/
                'Iptc.Application2.Copyright' : copyrightText, /*128 bytes*/
                'Iptc.Application2.Caption' : description, /*2000 bytes*/
                /*XMP*/
                'Xmp.dc.format' : 'image/jpeg',
                'Xmp.dc.title' : inventoryNum,
                'Xmp.dc.description' : description,
                'Xmp.dc.creator' : config.attribution,
                'Xmp.dc.rights' : copyrightText,
                'Xmp.xmpRights.Marked' : 'True', 
                'Xmp.xmpRights.WebStatement' : webStatement
            }
            deferred.resolve(newTags);
        })
        .catch(function (error) {
            logger.error('lookupArtwork', error);
            deferred.reject(error);
        });
        
        return deferred.promise;
    } 
    return Image;
})();

module.exports = Image;
