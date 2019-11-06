import revpimodio2
import sys
#def eventfunction(ioname, iovalue):
        #print("Event {} has the value of {}".format(ioname,iovalue))
#       print(iovalue)

try:
    raw_input          # Python 2
except NameError:
    raw_input = input  # Python 3

if len(sys.argv) > 1:
    pin_input = sys.argv[1]
    rpi = revpimodio2.RevPiModIO(autorefresh=True)
    rpi.handlesignalend()
    print(rpi.io[pin_input].value)
    #print("Starting main loop")
    rpi.mainloop()

#     while True:
#         try:
#             data = raw_input()
#             if 'close' in data:
#                 sys.exit(0)
#         except (EOFError, SystemExit):        # hopefully always caused by us sigint'ing the program
#             sys.exit(0)
else:
    print("Bad parameters - input_pin")