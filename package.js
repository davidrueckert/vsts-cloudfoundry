var through = require('through2');
var gutil = require('gulp-util');
var path = require('path');
var fs = require('fs');
var check = require('validator');
var shell = require('shelljs');
var Q = require('q');
var os = require('os');
var exec = require('child_process').exec;

var _strRelPath = path.join('Strings', 'resources.resjson', 'en-US');

var _tempPath = path.join(__dirname, '_temp');
shell.mkdir('-p', _tempPath);

var createError = function (msg) {
	return new gutil.PluginError('PackageTask', msg);
}

var validateModule = function (folderName, module) {
	var defer = Q.defer();
	defer.resolve();
	return defer.promise;
}

var validateTask = function (folderName, task) {
	var defer = Q.defer();

	var vn = (task.name || folderName);

	if (!task.id || !check.isUUID(task.id)) {
		defer.reject(createError(vn + ': id is a required guid'));
	};

	if (!task.name || !check.isAlphanumeric(task.name)) {
		defer.reject(createError(vn + ': name is a required alphanumeric string'));
	}

	if (!task.friendlyName || !check.isLength(task.friendlyName, 1, 40)) {
		defer.reject(createError(vn + ': friendlyName is a required string <= 40 chars'));
	}

	if (!task.instanceNameFormat) {
		defer.reject(createError(vn + ': instanceNameFormat is required'));
	}

	// resolve if not already rejected
	defer.resolve();
	return defer.promise;
};

var LOC_FRIENDLYNAME = 'loc.friendlyName';
var LOC_HELPMARKDOWN = 'loc.helpMarkDown';
var LOC_DESCRIPTION = 'loc.description';
var LOC_INSTFORMAT = 'loc.instanceNameFormat';
var LOC_GROUPDISPLAYNAME = 'loc.group.displayName.';
var LOC_INPUTLABEL = 'loc.input.label.';
var LOC_INPUTHELP = 'loc.input.help.';
var LOC_MESSAGES = 'loc.messages.';

var createStrings = function (task, pkgPath, srcPath) {
	var defer = Q.defer();

	var strPath = path.join(pkgPath, _strRelPath);
	shell.mkdir('-p', strPath);
	var srcStrPath = path.join(srcPath, _strRelPath);
	shell.mkdir('-p', srcStrPath);

	//
	// Loc tasks.json and product strings content
	//
	var strings = {};
	strings[LOC_FRIENDLYNAME] = task.friendlyName;
	task['friendlyName'] = 'ms-resource:' + LOC_FRIENDLYNAME;

	strings[LOC_HELPMARKDOWN] = task.helpMarkDown;
	task['helpMarkDown'] = 'ms-resource:' + LOC_HELPMARKDOWN;

	strings[LOC_DESCRIPTION] = task.description;
	task['description'] = 'ms-resource:' + LOC_DESCRIPTION;

	strings[LOC_INSTFORMAT] = task.instanceNameFormat;
	task['instanceNameFormat'] = 'ms-resource:' + LOC_INSTFORMAT;

	if (task.groups) {
		task.groups.forEach(function (group) {
			if (group.name) {
				var key = LOC_GROUPDISPLAYNAME + group.name;
				strings[key] = group.displayName;
				group.displayName = 'ms-resource:' + key;
			}
		});
	}

	if (task.inputs) {
		task.inputs.forEach(function (input) {
			if (input.name) {
				var labelKey = LOC_INPUTLABEL + input.name;
				strings[labelKey] = input.label;
				input.label = 'ms-resource:' + labelKey;

				if (input.helpMarkDown) {
					var helpKey = LOC_INPUTHELP + input.name;
					strings[helpKey] = input.helpMarkDown;
					input.helpMarkDown = 'ms-resource:' + helpKey;
				}
			}
		});
	}

	if (task.messages) {
		for (var key in task.messages) {
			var messageKey = LOC_MESSAGES + key;
			strings[messageKey] = task.messages[key];
			task.messages[key] = 'ms-resource:' + messageKey;
		}
	}

	//
	// Write the tasks.json and strings file in package and back to source
	//
	var enPath = path.join(strPath, 'resources.resjson');
	var enSrcPath = path.join(srcStrPath, 'resources.resjson');

	var enContents = JSON.stringify(strings, null, 2);
	fs.writeFile(enPath, enContents, function (err) {
		if (err) {
			defer.reject(createError('could not create: ' + enPath + ' - ' + err.message));
			return;
		}

		var taskPath = path.join(pkgPath, 'task.loc.json');

		var contents = JSON.stringify(task, null, 2);

		fs.writeFile(taskPath, contents, function (err) {
			if (err) {
				defer.reject(createError('could not create: ' + taskPath + ' - ' + err.message));
				return;
			}

			// copy the loc assets back to the src so they can be checked in
			shell.cp('-f', enPath, enSrcPath);
			shell.cp('-f', taskPath, path.join(srcPath, 'task.loc.json'));

			defer.resolve();
		});

	})

	return defer.promise;
};

function locCommon() {
	return through.obj(
		function (moduleJson, encoding, done) {
			// Validate the module.json file exists.
			if (!fs.existsSync(moduleJson)) {
				new gutil.PluginError('PackageModule', 'Module json cannot be found: ' + moduleJson.path);
			}

			if (moduleJson.isNull() || moduleJson.isDirectory()) {
				this.push(moduleJson);
				return callback();
			}

			// Deserialize the module.json.
			var jsonContents = moduleJson.contents.toString();
			var module = {};
			try {
				module = JSON.parse(jsonContents);
			}
			catch (err) {
				done(createError('Common module ' + moduleJson.path + ' parse error: ' + err.message));
				return;
			}

			// Build the content for the en-US resjson file.
			var strPath = path.join(path.dirname(moduleJson.path), _strRelPath);
			shell.mkdir('-p', strPath);
			var strings = {};
			if (module.messages) {
				for (var key in module.messages) {
					var messageKey = LOC_MESSAGES + key;
					strings[messageKey] = module.messages[key];
				}
			}

			// Create the en-US resjson file.
			var enPath = path.join(strPath, 'resources.resjson');
			var enContents = JSON.stringify(strings, null, 2);
			fs.writeFile(enPath, enContents, function (err) {
				if (err) {
					done(createError('Could not create: ' + enPath + ' - ' + err.message));
					return;
				}
			})

			done();
		});
}

function packageVsix(vsixPath, manifestDir) {
	var defer = Q.defer();

	shell.mkdir('-p', vsixPath);

	shell.pushd(manifestDir);

	var manifest = "extension-manifest.json";
	var tfx = path.join(__dirname, 'node_modules', 'tfx-cli', '_build', 'app.js');
	var commandLine = "node " + tfx + " extension create --manifest-globs " + manifest;
	console.log("Running: " + commandLine);
	exec(commandLine, function (err, stdout, stderr) {
		if (err) {
			shell.popd();
			defer.reject(err);
			return;
		}

		if (stdout) {
			gutil.log(stdout);
		}

		if (stderr) {
			gutil.log(stderr);
		}

		shell.mv('-f', "*.vsix", vsixPath);
		shell.popd();
		defer.resolve();
	});

	return defer.promise;
}

function packageTask(pkgPath, commonDeps, commonSrc) {
	return through.obj(
		function (taskJson, encoding, done) {
			if (!fs.existsSync(taskJson)) {
				new gutil.PluginError('PackageTask', 'Task json cannot be found: ' + taskJson.path);
			}

			if (taskJson.isNull() || taskJson.isDirectory()) {
				this.push(taskJson);
				return callback();
			}

			var dirName = path.dirname(taskJson.path);
			var folderName = path.basename(dirName);
			var jsonContents = taskJson.contents.toString();
			var extensionPath = path.dirname(dirName);
			var vsixPath = path.join(path.dirname(pkgPath), "Package");
			var task = {};

			try {
				task = JSON.parse(jsonContents);
			}
			catch (err) {
				done(createError(folderName + ' parse error: ' + err.message));
				return;
			}

			var tgtPath;

			validateTask(folderName, task)
				.then(function () {
					// Copy the task to the layout folder.
					gutil.log('Packaging: ' + task.name);
					tgtPath = path.join(pkgPath, task.name);
					shell.mkdir('-p', tgtPath);
					shell.cp('-R', path.join(dirName, '*'), tgtPath);
					shell.rm(path.join(tgtPath, '*.csproj'));
					shell.rm(path.join(tgtPath, '*.md'));

					// Build a list of external task lib dependencies.
					var externals = require('./externals.json');
					var libDeps = [];
					if (task.execution['Node10']) {
						libDeps.push({
							"name": "azure-pipelines-task-lib",
							"src": "node_modules",
							"dest": "node_modules"
						}, {
								"name": "azure-pipelines-tool-lib",
								"src": "node_modules",
								"dest": "node_modules"
							});
					}

					if (task.execution['PowerShell3']) {
						libDeps.push({
							"name": "vsts-task-sdk",
							"src": path.join("node_modules", "vsts-task-sdk", "VstsTaskSdk"),
							"dest": path.join("ps_modules", "VstsTaskSdk")
						});
					}

					// Statically link the required external task libs.
					libDeps.forEach(function (libDep) {
						var libVer = externals[libDep.name];
						if (!libVer) {
							throw new Error('External ' + libDep.name + ' not defined in externals.json.');
						}

						gutil.log('Linking ' + libDep.name + ' ' + libVer + ' into ' + task.name);
						var tskLibSrc = path.join(__dirname, '_temp', libDep.name, libVer, libDep.src);
						if (shell.test('-d', tskLibSrc)) {
							new gutil.PluginError('PackageTask', libDep.name + ' not found: ' + tskLibSrc);
						}

						var dest = path.join(tgtPath, libDep.dest)
						shell.mkdir('-p', dest);
						shell.cp('-R', path.join(tskLibSrc, '*'), dest);
					})

					// Statically link the required internal common modules.
					var taskDeps;
					if ((taskDeps = commonDeps[task.name])) {
						taskDeps.forEach(function (dep) {
							console.log("remove me -- " + dep);
							gutil.log('Linking ' + dep.module + ' into ' + task.name);
							var src = path.join(commonSrc, dep.module);
							var dest = path.join(tgtPath, dep.dest);
							shell.mkdir('-p', dest);
							shell.cp('-R', src, dest);
						})
					}

					return;
				})
				.then(function () {
					return createStrings(task, tgtPath, dirName);
				})
				.then(function () {
					done();
				})
				.fail(function (err) {
					done(err);
				})
		});
}

exports.LocCommon = locCommon;
exports.PackageTask = packageTask;
exports.PackageVsix = packageVsix;
